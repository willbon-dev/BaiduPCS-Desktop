'use strict'

/**
 * BaiduPCS Desktop —— BaiduPCS-Rust 的桌面壳
 *
 * 设计要点：
 *  - 后端 exe 以 windowsHide 方式隐藏启动，全程无命令行窗口
 *  - 关闭按钮 = 销毁窗口（渲染进程直接退出，内存归还），程序退到托盘
 *  - 托盘态仅保留 Electron 主进程（约 60~90MB）+ Rust 后端自身占用
 *  - 端口已有服务（例如你自己手动跑着的后端）时直接复用，绝不重复启动，
 *    退出时也只会杀掉本应用自己启动的后端
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell } = require('electron')
const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises

const SMOKE = process.env.BAIDUPCS_SMOKE === '1'

// 禁用 GPU 进程：页面是纯文件管理 UI，软件渲染足够，
// 换来的是托盘态不再常驻一个 GPU 辅助进程（省 50~100MB）
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('renderer-process-limit', '1')

// ---------- 常量与状态 ----------

const PORT_CANDIDATES = [18888, 8080]
const BACKEND_WAIT_MS = 90_000
const MAIN_URL = (port) => `http://127.0.0.1:${port}/`

let win = null
let tray = null
let backend = null            // 本应用启动的后端子进程
let backendManaged = false    // 后端是否由本应用托管
let backendPort = null        // 最终探测可用的端口
let backendVersion = null     // backend/VERSION 里的上游 tag
let quitting = false
let notifiedHidden = false
let opening = null            // 打开流程单飞（防止并发重复 spawn）

const backendDir = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(__dirname, 'backend'))
const wrapperLogPath = () => path.join(app.getPath('userData'), 'wrapper.log')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  try { fs.appendFileSync(wrapperLogPath(), line + '\n') } catch { /* 忽略日志失败 */ }
  if (!app.isPackaged || SMOKE) console.log(line)
}

// ---------- 小工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 递归找 exe（zip 解压后形如 backend/BaiduPCS-Rust-vX.Y.Z-windows-x86_64/baidu-netdisk-rust.exe）
function findBackendExe(dir = backendDir()) {
  if (!fs.existsSync(dir)) return null
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isFile() && name.toLowerCase().endsWith('.exe')) return p
    if (st.isDirectory()) {
      const r = findBackendExe(p)
      if (r) return r
    }
  }
  return null
}

// 后端工作目录 = exe 所在目录（上游便携设计：config/frontend/downloads 都在 exe 旁）
function backendCwd() {
  const exe = findBackendExe()
  return exe ? path.dirname(exe) : null
}

function readBackendVersion() {
  try { return fs.readFileSync(path.join(backendDir(), 'VERSION'), 'utf8').trim() } catch { return null }
}

// 后端配置文件里若写了 port = xxxx，优先采用
async function configPort() {
  const cwd = backendCwd()
  if (!cwd) return null
  try {
    const t = await fsp.readFile(path.join(cwd, 'config', 'app.toml'), 'utf8')
    const m = t.match(/^\s*port\s*=\s*(\d+)/m)
    if (m) return Number(m[1])
  } catch { /* 无配置文件，使用默认 */ }
  return null
}

async function probePort(port, timeoutMs = 1200) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal })
    return res.status >= 100 && res.status < 600 // 任何 HTTP 响应都算服务存活
  } catch { return false } finally { clearTimeout(timer) }
}

async function firstAlivePort(ports) {
  for (const p of ports) if (await probePort(p)) return p
  return null
}

// ---------- 后端进程管理 ----------

function ensureDirs() {
  // 上游约定目录（相对 exe 所在目录）：config/data/logs/wal/downloads
  const cwd = backendCwd()
  if (!cwd) return
  for (const d of ['config', 'data', 'logs', 'wal', 'downloads']) {
    fs.mkdirSync(path.join(cwd, d), { recursive: true })
  }
}

function truncateWrapperLog() {
  try {
    const p = wrapperLogPath()
    if (fs.existsSync(p) && fs.statSync(p).size > 8 * 1024 * 1024) fs.writeFileSync(p, '')
  } catch { /* 忽略 */ }
}

function startBackend() {
  const exe = findBackendExe()
  if (!exe) {
    const err = `后端未找到：${backendDir()} 目录下没有 .exe。请先运行 npm run fetch-backend`
    log('ERROR', err)
    throw new Error(err)
  }
  const cwd = path.dirname(exe)
  truncateWrapperLog()
  const out = fs.openSync(wrapperLogPath(), 'a')
  log('启动后端：', exe, 'cwd=', cwd)
  const child = spawn(exe, [], {
    cwd,
    windowsHide: true,                     // 关键：不弹黑色命令行窗口
    stdio: ['ignore', out, out],
  })
  backend = child
  backendManaged = true
  child.on('exit', (code) => {
    log('后端退出 code=', code)
    try { fs.closeSync(out) } catch { /* 忽略 */ }
    if (backend === child) { backend = null; backendManaged = false }
    if (quitting || child.suppressExit) return
    if (win && !win.isDestroyed()) {
      win.webContents.send?.('bpcs:backend-exit')
      win.loadFile('error.html', { query: { reason: 'backend-exit', code: String(code) } }).catch(() => {})
    }
    new Notification({
      title: 'BaiduPCS 后台进程已退出',
      body: '点击托盘图标重新打开，会自动尝试重新启动后台服务。',
      silent: true,
    }).show()
  })
  return child
}

function killBackend() {
  const child = backend
  backend = null
  backendManaged = false
  if (!child || !child.pid) return
  child.suppressExit = true // 主动结束不弹“后端已退出”提醒
  log('结束后端 pid=', child.pid)
  try {
    // /T 连同子进程整棵杀掉，/F 强制
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } catch { /* 忽略 */ }
  try { child.kill() } catch { /* 忽略 */ }
}

// ---------- 窗口 ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1420',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    title: 'BaiduPCS Desktop',
    webPreferences: {
      partition: 'persist:bpcs',           // cookie 持久化：托盘重建窗口后登录态不丢
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.setMenuBarVisibility(false)

  win.once('ready-to-show', () => win.show())

  // 关闭 = 销毁窗口退到托盘（释放渲染进程内存），真正的退出走托盘菜单
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.destroy()
    win = null
    if (!notifiedHidden && !SMOKE) {
      notifiedHidden = true
      new Notification({
        title: 'BaiduPCS Desktop 已最小化到托盘',
        body: '程序仍在后台运行，点击托盘图标可重新打开；在托盘右键菜单中可完全退出。',
        silent: true,
      }).show()
    }
  })

  // 页面里 target=_blank：同源弹窗允许（可能有预览类功能），外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    const sameOrigin = backendPort && url.startsWith(`http://127.0.0.1:${backendPort}`)
    if (sameOrigin) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (!isMain || !win || win.isDestroyed()) return
    if (code === -3) return // ABORTED：主动取消的导航，忽略
    log('页面加载失败 code=', code, desc)
    win.loadFile('error.html', { query: { reason: 'load-failed', code: String(code), desc } }).catch(() => {})
  })

  return win
}

async function openMainWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }

  // 单飞：加载期间重复点托盘不再进入第二次流程
  if (opening) { await opening; return }

  opening = (async () => {
    try {
      createWindow()
      await win.loadFile('loading.html')
      if (!win || win.isDestroyed()) return

      let port = backendPort
      if (!port) {
        const cfgPort = await configPort()
        const candidates = [...new Set([cfgPort, ...PORT_CANDIDATES].filter(Boolean))]
        const busy = await firstAlivePort(candidates)
        if (busy) {
          // 已有后端在跑（可能是用户自己手动启动的）——直接复用，不重复启动
          log('端口', busy, '已有服务，复用现有后端（不由本应用托管）')
          backendManaged = false
          backendPort = busy
          port = busy
        } else {
          try {
            startBackend()
          } catch (err) {
            await win.loadFile('error.html', { query: { reason: 'no-backend' } }).catch(() => {})
            return
          }
          port = await waitBackendReady(candidates)
          backendPort = port
          if (!win || win.isDestroyed()) return // 等待期间窗口被关掉，后端继续在后台跑
        }
      }

      if (!port) {
        await win.loadFile('error.html', { query: { reason: 'backend-timeout' } }).catch(() => {})
        return
      }

      log('加载页面：', MAIN_URL(port))
      await win.loadURL(MAIN_URL(port))
      updateTrayToolTip()

      if (SMOKE) await runSmoke(port)
    } finally {
      opening = null
    }
  })()

  await opening
}

async function waitBackendReady(candidates) {
  const deadline = Date.now() + BACKEND_WAIT_MS
  while (Date.now() < deadline) {
    const p = await firstAlivePort(candidates)
    if (p) return p
    // 后端已经自己退出（如配置错误）就不必等满 90 秒
    if (backendManaged && !backend) return null
    await sleep(500)
  }
  return null
}

// ---------- 托盘 ----------

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
  tray = new Tray(img)
  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => openMainWindow() },
    { type: 'separator' },
    {
      label: '退出（结束后台进程）',
      click: () => {
        quitting = true
        killBackend()
        app.quit()
      },
    },
  ])
  // 左键单击打开窗口；右键弹出菜单（不用 setContextMenu，避免左键也弹菜单）
  tray.on('click', () => openMainWindow())
  tray.on('right-click', () => tray.popUpContextMenu(menu))
  updateTrayToolTip()
}

function updateTrayToolTip() {
  if (!tray) return
  const parts = [`BaiduPCS Desktop v${app.getVersion()}`]
  if (backendVersion) parts.push(`后端 ${backendVersion}`)
  if (backendPort) parts.push(backendManaged ? `运行中 :${backendPort}` : `已连接 :${backendPort}（外部实例）`)
  else if (!backendManaged) parts.push('后台未运行')
  tray.setToolTip(parts.join(' · '))
}

// ---------- 冒烟测试（BAIDUPCS_SMOKE=1 时启用，正常使用不会走到） ----------

async function runSmoke(port) {
  const result = { loaded: false, port, closeToTray: false, backendAliveAfterClose: false }
  try {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(__dirname, 'smoke-window.png'), img.toPNG())
    result.loaded = true
  } catch (e) { result.captureError = String(e) }

  win.close() // 应走 destroy 分支而不是退出应用
  await sleep(1500)
  result.closeToTray = (win === null) && !!tray && !quitting
  result.backendAliveAfterClose = await probePort(port)

  fs.writeFileSync(path.join(__dirname, 'smoke-result.json'), JSON.stringify(result, null, 2))
  log('SMOKE RESULT', JSON.stringify(result))
  quitting = true
  killBackend()
  app.exit(0)
}

// ---------- 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { openMainWindow() })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.willbon.baidupcs.desktop')
    backendVersion = readBackendVersion()
    ensureDirs()
    createTray()
    await openMainWindow()
  })

  app.on('before-quit', () => {
    quitting = true
    killBackend()
  })

  // 托盘常驻：所有窗口都销毁时不退出
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })

  ipcMain.on('bpcs:retry', () => {
    log('用户请求重试')
    killBackend()
    backendPort = null
    if (win && !win.isDestroyed()) { win.destroy(); win = null }
    openMainWindow()
  })

  ipcMain.handle('bpcs:get-info', () => ({
    version: app.getVersion(),
    backendVersion,
    port: backendPort,
    managed: backendManaged,
    backendDir: backendDir(),
    backendCwd: backendCwd(),
    wrapperLog: wrapperLogPath(),
  }))
}
