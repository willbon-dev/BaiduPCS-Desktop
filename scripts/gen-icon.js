'use strict'

/**
 * 纯 Node 生成应用图标（零依赖，不联网）：
 *   assets/icon.png  (256)   窗口图标
 *   assets/tray.png  (32)    托盘图标
 *   assets/icon.ico  (16/24/32/48/256)  打包用 Windows 图标
 * 图案：蓝色渐变圆角方块 + 白云 + 下穿箭头（下载/网盘意象）
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 绘制（坐标均为 0~1 相对值） ----------
const roundedRectSDF = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const inCircle = (px, py, cx, cy, r) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r
const inTriangle = (px, py, a, b, c) => {
  const s = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = s(a, b, [px, py]), d2 = s(b, c, [px, py]), d3 = s(c, a, [px, py])
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}
const lerp = (a, b, t) => a + (b - a) * t

function sample(u, v, withArrow) {
  // 背景渐变
  const top = [86, 158, 255], bottom = [23, 84, 226]
  const g = [lerp(top[0], bottom[0], v), lerp(top[1], bottom[1], v), lerp(top[2], bottom[2], v)]
  // 圆角方块外 → 透明
  if (roundedRectSDF(u, v, 0.5, 0.5, 0.5, 0.5, 0.21) > 0) return [0, 0, 0, 0]

  // 白色云朵 = 三圆 + 圆角横带
  const cloud = inCircle(u, v, 0.355, 0.50, 0.135) ||
    inCircle(u, v, 0.500, 0.415, 0.165) ||
    inCircle(u, v, 0.645, 0.50, 0.135) ||
    roundedRectSDF(u, v, 0.5, 0.545, 0.21, 0.085, 0.085) <= 0

  if (cloud) {
    // 下穿箭头按背景渐变色“镂空”
    const stem = roundedRectSDF(u, v, 0.5, 0.475, 0.032, 0.09, 0.032) <= 0
    const head = inTriangle(u, v, [0.428, 0.545], [0.572, 0.545], [0.5, 0.675])
    if (withArrow && (stem || head)) return [...g, 255]
    return [255, 255, 255, 255]
  }
  return [...g, 255]
}

function render(size, withArrow = true) {
  const buf = Buffer.alloc(size * size * 4)
  const n = size <= 48 ? 3 : 2 // 小尺寸用更细的超采样
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const [pr, pg, pb, pa] = sample((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size, withArrow)
          r += pr; g += pg; b += pb; a += pa
        }
      }
      const cnt = n * n
      const i = (y * size + x) * 4
      buf[i] = Math.round(r / cnt)
      buf[i + 1] = Math.round(g / cnt)
      buf[i + 2] = Math.round(b / cnt)
      buf[i + 3] = Math.round(a / cnt)
    }
  }
  return buf
}

// ---------- ICO ----------
function icoEntryBMP(size, rgba) {
  const xorSize = size * size * 4
  const andRow = Math.ceil(size / 32) * 4
  const andSize = andRow * size
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8) // XOR + AND 高度
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  head.writeUInt32LE(xorSize + andSize, 20)
  const xor = Buffer.alloc(xorSize)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = ((size - 1 - y) * size + x) * 4
      const di = (y * size + x) * 4
      xor[di] = rgba[si + 2]; xor[di + 1] = rgba[si + 1]; xor[di + 2] = rgba[si]; xor[di + 3] = rgba[si + 3]
    }
  }
  return Buffer.concat([head, xor, Buffer.alloc(andSize)])
}

function encodeICO(entries) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  const des = []
  let off = 6 + entries.length * 16
  for (const e of entries) {
    const de = Buffer.alloc(16)
    de[0] = e.size >= 256 ? 0 : e.size
    de[1] = e.size >= 256 ? 0 : e.size
    de.writeUInt16LE(1, 4)
    de.writeUInt16LE(32, 6)
    de.writeUInt32LE(e.data.length, 8)
    de.writeUInt32LE(off, 12)
    off += e.data.length
    des.push(de)
  }
  return Buffer.concat([dir, ...des, ...entries.map((e) => e.data)])
}

// ---------- 生成 ----------
const assets = path.join(__dirname, '..', 'assets')
fs.mkdirSync(assets, { recursive: true })
fs.writeFileSync(path.join(assets, 'icon.png'), encodePNG(256, 256, render(256, true)))
fs.writeFileSync(path.join(assets, 'tray.png'), encodePNG(32, 32, render(32, true)))
fs.writeFileSync(path.join(assets, 'icon.ico'), encodeICO([
  ...[16, 24, 32, 48].map((s) => ({ size: s, data: icoEntryBMP(s, render(s, s >= 32)) })),
  { size: 256, data: encodePNG(256, 256, render(256, true)) },
]))
console.log('图标已生成: assets/icon.ico, assets/icon.png, assets/tray.png')
