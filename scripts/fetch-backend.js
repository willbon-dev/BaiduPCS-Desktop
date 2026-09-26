'use strict'

/**
 * 下载上游 BaiduPCS-Rust Windows 版并解压到 backend/
 * 用法: node scripts/fetch-backend.js [--tag v2.2.4]
 * 环境变量: GH_PROXY=https://ghfast.top  手动指定 GitHub 加速代理前缀（国内网络推荐）
 */

const fs = require('fs')
const path = require('path')
const fsp = fs.promises
const AdmZip = require('adm-zip')

const REPO = 'komorebiCarry/BaiduPCS-Rust'
const MIRRORS = ['', 'https://gh.ddlc.top/', 'https://ghfast.top/', 'https://gh-proxy.com/']
const BACKEND_DIR = path.join(__dirname, '..', 'backend')
const HEADERS = { 'User-Agent': 'baidupcs-desktop-build' }

function argTag() {
  const i = process.argv.indexOf('--tag')
  return i >= 0 ? process.argv[i + 1] : null
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { signal: ac.signal, headers: HEADERS, redirect: 'follow' }) }
  finally { clearTimeout(t) }
}

async function resolveTag(tagArg) {
  if (tagArg) return tagArg.startsWith('v') ? tagArg : 'v' + tagArg
  const api = `https://api.github.com/repos/${REPO}/releases/latest`
  for (const m of MIRRORS) {
    try {
      const res = await fetchWithTimeout(m + api, 20000)
      if (res.ok) {
        const j = await res.json()
        if (j.tag_name) return j.tag_name
      }
    } catch (e) {
      console.log(`查询最新版本失败（${m || 'GitHub 直连'}）: ${e.message}`)
    }
  }
  throw new Error('无法获取最新版本号。请检查网络，或手动指定版本：node scripts/fetch-backend.js --tag v2.2.4')
}

async function downloadTo(url, dest, ms = 600000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: HEADERS, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 5 * 1024 * 1024) throw new Error(`文件过小(${(buf.length / 1024 / 1024).toFixed(2)}MB)，疑似失败页`)
    await fsp.writeFile(dest, buf)
    return buf.length
  } finally { clearTimeout(t) }
}

function findExe(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isFile() && name.toLowerCase().endsWith('.exe')) return p
    if (st.isDirectory()) {
      const r = findExe(p)
      if (r) return r
    }
  }
  return null
}

// 桌面版配置补丁：上游自带的 app.toml 是 docker 风格的，
// allowed_paths 指向 /data/uploads 会导致本地上传选择器被限制，放开之
async function patchConfig() {
  for (const name of await fsp.readdir(BACKEND_DIR)) {
    const p = path.join(BACKEND_DIR, name, 'config', 'app.toml')
    try {
      let t = await fsp.readFile(p, 'utf8')
      const before = t
      t = t.replace(/^(\s*allowed_paths\s*=\s*)\[[^\]]*\]/m, '$1[]')
      t = t.replace(/^(\s*default_path\s*=\s*)"[^"]*"/m, '$1""')
      if (t !== before) {
        await fsp.writeFile(p, t)
        console.log('已调整 config/app.toml：allowed_paths=[]（上传选择器不限制目录）')
      }
      return
    } catch { /* 该子目录没有 config/app.toml，继续找 */ }
  }
  console.log('提示：压缩包内未找到 config/app.toml，跳过配置调整')
}

async function main() {
  const tag = await resolveTag(argTag())
  const asset = `BaiduPCS-Rust-${tag}-windows-x86_64.zip`
  const urlPath = `https://github.com/${REPO}/releases/download/${tag}/${asset}`
  const dest = path.join(BACKEND_DIR, asset)

  await fsp.mkdir(BACKEND_DIR, { recursive: true })
  console.log(`上游版本: ${tag}`)

  const prefixes = process.env.GH_PROXY
    ? [process.env.GH_PROXY.replace(/\/?$/, '/'), ...MIRRORS]
    : MIRRORS
  let size = 0
  for (const m of prefixes) {
    console.log(`尝试下载: ${m || 'GitHub 直连'}`)
    try {
      size = await downloadTo(m + urlPath, dest)
      break
    } catch (e) {
      console.log(`  失败: ${e.message}`)
    }
  }
  if (!size) throw new Error('所有下载方式均失败。国内网络可设置环境变量 GH_PROXY=https://ghfast.top 后重试')

  console.log(`下载完成: ${(size / 1024 / 1024).toFixed(1)} MB，解压中…`)
  const zip = new AdmZip(dest)
  // 清理旧文件（保留 README.md），再解压新版本
  for (const f of await fsp.readdir(BACKEND_DIR)) {
    if (f !== 'README.md' && f !== asset) await fsp.rm(path.join(BACKEND_DIR, f), { recursive: true, force: true })
  }
  zip.extractAllTo(BACKEND_DIR, true)
  await fsp.writeFile(path.join(BACKEND_DIR, 'VERSION'), tag + '\n')
  await patchConfig()
  await fsp.rm(dest, { force: true })

  const exe = findExe(BACKEND_DIR)
  if (!exe) throw new Error(`压缩包内未找到 .exe，包结构可能变化，请检查 ${BACKEND_DIR}`)
  console.log('完成 ✓  后端程序:', path.relative(path.join(__dirname, '..'), exe))
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
