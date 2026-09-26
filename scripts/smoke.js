'use strict'

/**
 * 冒烟测试：真实启动应用（会占用 18888 端口，请确保没有其他实例在跑）
 * 用法: npm run smoke
 * 产物: smoke-result.json / smoke-window.png
 *
 * 验证项：
 *  1. 后端能隐藏启动且页面加载成功（截图留档）
 *  2. 关闭窗口后应用不退出、托盘仍在（销毁窗口而非隐藏）
 *  3. 关闭窗口后后端仍在运行
 *  4. 退出时后端进程被一并结束
 */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const electronPath = require('electron') // 普通 node 环境下 require('electron') 返回二进制路径

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, BAIDUPCS_SMOKE: '1' },
  windowsHide: true,
})

child.on('exit', (code) => {
  const resultFile = path.join(__dirname, '..', 'smoke-result.json')
  try {
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    console.log('\n===== 冒烟结果 =====')
    console.log(JSON.stringify(r, null, 2))
    const ok = r.loaded && r.closeToTray && r.backendAliveAfterClose
    console.log(ok ? '\n全部通过 ✓（退出后可到任务管理器确认无 BaiduPCS 残留进程）' : '\n存在失败项 ✗')
    console.log('窗口截图: smoke-window.png')
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('未生成冒烟结果文件:', e.message)
    process.exit(code || 1)
  }
})
