'use strict'

/**
 * 下载上游 BaiduPCS-Rust 指定平台的发布包并解压到 backend/
 * 用法:
 *   node scripts/fetch-backend.js                        # 当前平台最新版
 *   node scripts/fetch-backend.js --tag v2.2.4           # 指定版本
 *   node scripts/fetch-backend.js --os linux --arch aarch64   # CI 矩阵用
 * 环境变量: GH_PROXY=https://ghfast.top  手动指定 GitHub 加速代理前缀（国内网络推荐）
 */

const fs = require('fs')
const path = require('path')
const fsp = fs.promises
const { spawnSync } = require('child_process')
const AdmZip = require('adm-zip')

const REPO = 'komorebiCarry/BaiduPCS-Rust'
const MIRRORS = ['', 'https://gh.ddlc.top/', 'https://ghfast.top/', 'https://gh-proxy.com/']
const BACKEND_DIR = path.join(__dirname, '..', 'backend')
const HEADERS = { 'User-Agent': 'baidupcs-desktop-build' }

function parseArgs() {
  const get = (k) => {
    const i = process.argv.indexOf(k)
    return i >= 0 ? process.argv[i + 1] : null
  }
  const os = get('--os') ||
    ({ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform)
  const arch = get('--arch') || ({ x64: 'x86_64', arm64: 'aarch64' }[process.arch] || process.arch)
  const tagArg = get('--tag')
  const tag = tagArg ? (tagArg.startsWith('v') ? tagArg : 'v' + tagArg) : null
  return { os, arch, tag }
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { signal: ac.signal, headers: HEADERS, redirect: 'follow' }) }
  finally { clearTimeout(t) }
}

async function resolveTag(tagArg) {
  if (tagArg) return tagArg
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

// 上游不同平台的架构命名不统一（发布资产用 arm64，docker 资产用 amd64，部分文档写 aarch64），
// 匹配与拼名时把常见等价写法都试一遍，避免上游改名导致 404
const ARCH_ALIASES = {
  x86_64: ['x86_64', 'amd64'],
  aarch64: ['aarch64', 'arm64'],
}
const archTokens = (arch) => ARCH_ALIASES[arch] || [arch]

// 优先从 release API 取真实资产（上游 zip/tar.gz 命名偶有变化），
// API 不可用时按惯例拼出各候选 URL
async function resolveAssetUrls(tag, os, arch) {
  const tokens = archTokens(arch)
  const re = new RegExp(`-${os}-(${tokens.join('|')})\\.(zip|tar\\.gz)$`, 'i')
  let seenAssets = []
  const api = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
  for (const m of MIRRORS) {
    try {
      const res = await fetchWithTimeout(m + api, 20000)
      if (res.ok) {
        const j = await res.json()
        seenAssets = (j.assets || []).map((a) => a.name)
        const hit = seenAssets.find((name) => re.test(name))
        if (hit) {
          const asset = (j.assets || []).find((a) => a.name === hit)
          return { urls: [asset.browser_download_url], seenAssets }
        }
        break // API 正常但没有匹配资产，直接走拼名（资产清单会出现在失败提示里）
      }
    } catch (e) {
      console.log(`查询资产列表失败（${m || 'GitHub 直连'}）: ${e.message}`)
    }
  }
  const base = `https://github.com/${REPO}/releases/download/${tag}/BaiduPCS-Rust-${tag}-${os}`
  const urls = []
  for (const t of tokens) {
    urls.push(`${base}-${t}.zip`, `${base}-${t}.tar.gz`)
  }
  return { urls, seenAssets }
}

async function downloadTo(url, dest, ms = 600000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: HEADERS, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 3 * 1024 * 1024) throw new Error(`文件过小(${(buf.length / 1024 / 1024).toFixed(2)}MB)，疑似失败页`)
    await fsp.writeFile(dest, buf)
    return buf.length
  } finally { clearTimeout(t) }
}

function extract(archive, destDir) {
  if (archive.toLowerCase().endsWith('.zip')) {
    new AdmZip(archive).extractAllTo(destDir, true)
    return
  }
  const r = spawnSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`tar 解压失败，退出码 ${r.status}`)
}

// 递归找后端可执行文件（Windows: *.exe；macOS/Linux: baidu-netdisk-rust*）
function findBinary(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isFile()) {
      const n = name.toLowerCase()
      if (process.platform === 'win32' && n.endsWith('.exe')) return p
      if (process.platform !== 'win32' && n.startsWith('baidu-netdisk-rust')) return p
    } else if (st.isDirectory()) {
      const r = findBinary(p)
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
  const { os, arch, tag: tagArg } = parseArgs()
  const tag = await resolveTag(tagArg)
  await fsp.mkdir(BACKEND_DIR, { recursive: true })
  console.log(`上游版本: ${tag}  平台: ${os}-${arch}`)

  const { urls, seenAssets } = await resolveAssetUrls(tag, os, arch)
  // GitHub Actions 上访问 GitHub 本来就快，不引入第三方镜像；本地按需走加速
  const onCi = process.env.GITHUB_ACTIONS === 'true'
  const prefixes = onCi
    ? ['']
    : process.env.GH_PROXY
      ? [process.env.GH_PROXY.replace(/\/?$/, '/'), ...MIRRORS]
      : MIRRORS
  if (onCi) console.log('CI 环境：仅使用 GitHub 直连')

  let archive = null
  let size = 0
  for (const url of urls) {
    const file = path.join(BACKEND_DIR, path.basename(url))
    for (const m of prefixes) {
      console.log(`尝试下载: ${m || 'GitHub 直连'} ${path.basename(url)}`)
      try {
        size = await downloadTo(m + url, file)
        archive = file
        break
      } catch (e) {
        console.log(`  失败: ${e.message}`)
      }
    }
    if (archive) break
  }
  if (!archive) {
    const hint = seenAssets.length
      ? `上游 ${tag} 的实际资产：\n  ${seenAssets.join('\n  ')}`
      : '未能读取上游资产列表（GitHub API 不可达）'
    throw new Error(`所有下载方式均失败。\n${hint}\n国内网络可设置环境变量 GH_PROXY=https://ghfast.top 后重试`)
  }

  console.log(`下载完成: ${(size / 1024 / 1024).toFixed(1)} MB，解压中…`)
  // 清理旧文件（保留 README.md），再解压新版本
  for (const f of await fsp.readdir(BACKEND_DIR)) {
    if (f !== 'README.md' && f !== path.basename(archive)) {
      await fsp.rm(path.join(BACKEND_DIR, f), { recursive: true, force: true })
    }
  }
  extract(archive, BACKEND_DIR)
  await fsp.writeFile(path.join(BACKEND_DIR, 'VERSION'), tag + '\n')
  await patchConfig()
  await fsp.rm(archive, { force: true })

  const bin = findBinary(BACKEND_DIR)
  if (!bin) {
    throw new Error(`压缩包内未找到后端可执行文件（Windows 为 .exe，macOS/Linux 为 baidu-netdisk-rust），请检查 ${BACKEND_DIR}`)
  }
  if (process.platform !== 'win32') {
    await fsp.chmod(bin, 0o755) // tar.gz 的执行位可能丢失，补上
  }
  console.log('完成 ✓  后端程序:', path.relative(path.join(__dirname, '..'), bin))
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
