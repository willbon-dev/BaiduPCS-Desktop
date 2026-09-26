'use strict'

// CI 用：把上游版本号写入 package.json
// 用法: node scripts/set-version.js 2.2.4

const fs = require('fs')
const path = require('path')

const ver = process.argv[2]
if (!ver || !/^\d+\.\d+\.\d+/.test(ver)) {
  console.error('用法: node scripts/set-version.js <x.y.z>')
  process.exit(1)
}
const pkgPath = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = ver
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('package.json version ->', ver)
