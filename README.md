# BaiduPCS Desktop

[BaiduPCS-Rust](https://github.com/komorebiCarry/BaiduPCS-Rust) 的 Windows 桌面壳（Electron）：

- **无命令行窗口**：Rust 后端以隐藏方式启动，桌面上只有一个正常的应用窗口
- **点开即页面**：启动后自动等待本地服务就绪并加载 Web 界面（默认 `127.0.0.1:18888`）
- **关闭 = 退到托盘**：点关闭按钮直接**销毁**窗口（渲染进程退出，内存归还系统），程序驻留托盘
- **托盘可退出**：托盘左键打开主界面，右键菜单 → 退出（同时结束后端进程树）
- **低资源占用**：全局禁用 GPU 进程；托盘态仅剩 Electron 主进程（约 60~90MB）+ Rust 后端本身
- **长列表自动分页**：上传/下载/转存/云下载/文件列表任务过多时（默认超 100 条），壳层自动注入分页条（100/200/500/不限 条每页），隐藏视口外条目的渲染，避免页面卡顿；上游将来若自带分页会自动让位
- **五平台矩阵构建**：Windows x64、Linux x64/ARM64、macOS Intel/Apple Silicon，与上游发布节奏一一对应
- **端口冲突安全**：启动时若发现 18888 已有服务（例如你手动运行的后端），直接复用不重复启动；退出也只杀自己启动的后端
- **自动跟随上游**：GitHub Actions 每 6 小时检查上游 release，有新版本自动构建 zip 并发布到本仓库 Releases

## 目录结构

```
baidupcs-desktop/
├── main.js                  # Electron 主进程（后端管理/托盘/窗口/冒烟）
├── preload.js               # 渲染层桥（错误页重试、诊断信息）
├── loading.html / error.html
├── assets/                  # 图标（由 scripts/gen-icon.js 纯代码生成）
├── backend/                 # 构建时放入上游 exe（不提交二进制）
├── scripts/
│   ├── fetch-backend.js     # 下载上游 Windows 版（自动尝试国内加速代理）
│   ├── gen-icon.js          # 纯 Node 生成 PNG/ICO 图标（零依赖）
│   ├── set-version.js       # CI 同步版本号
│   └── smoke.js             # 冒烟测试（会真实启动，注意端口）
└── .github/workflows/auto-build.yml   # 自动构建工作流
```

## 本地开发

环境：Node.js 22（本机已安装于 `C:\Users\willbon\AppData\Local\Programs\nodejs`，已加入用户 PATH）。
npm 与 Electron 二进制均走 npmmirror 国内镜像（见 `.npmrc`）。

```bash
npm install                 # 安装 Electron 等（走国内镜像）
npm run fetch-backend       # 下载上游后端 exe 到 backend/（直连失败自动换代理）
npm start                   # 启动应用
npm run dist                # 打包 zip（输出到 dist/）
```

国内下载加速：

- 上游 exe 下载慢时：`set GH_PROXY=https://ghfast.top && npm run fetch-backend`
- Node/npm 已配置 npmmirror，无需额外设置

## 数据与日志位置

采用上游的**便携式布局**，所有数据都在后端 exe 旁边的目录里（解压到哪就用哪，方便整体备份/搬迁）：

```
BaiduPCS-Desktop 解压目录\
└── BaiduPCS-Rust-vX.Y.Z-windows-x86_64\
    ├── baidu-netdisk-rust.exe      # 后端
    ├── frontend\                   # Web 界面
    ├── config\app.toml             # 端口/下载目录/Web 认证等配置
    ├── downloads\                  # 默认下载目录
    ├── data\ logs\ wal\
```

壳自身的运行日志（启动后端、端口探测等）：`%APPDATA%\BaiduPCS Desktop\wrapper.log`。

两点说明：

- 上游默认 `host = "0.0.0.0"` 且 Web 认证关闭，局域网内其他设备可以访问你的管理界面；如在意，把 `config/app.toml` 的 `host` 改为 `"127.0.0.1"` 或按上游文档开启 `web_auth`
- 安装脚本会把 `config/app.toml` 的 `allowed_paths` 调整为 `[]`（不限制上传选择器目录），这是桌面使用的合理默认

## 冒烟测试（可选）

```bash
npm run smoke
```

会真实启动应用并自动验证：页面加载、关闭到托盘、后端存活、退出清理，并输出 `smoke-window.png` 截图与 `smoke-result.json`。**注意：会短暂占用 18888 端口，请先关闭正在运行的实例。**

## 自动构建（上传 GitHub 后）

1. 把本项目上传到你的 GitHub 仓库（`backend/` 里的二进制会被 gitignore，无需担心）
2. 仓库 Settings → Actions 确认工作流已启用
3. 之后每 6 小时自动检查上游 release，有新版本时五平台并行构建：

   | 平台 | 产物 |
   |---|---|
   | Windows x64 | `BaiduPCS-Desktop-*-*-win-x64.zip` |
   | Linux x64 / ARM64 | `BaiduPCS-Desktop-*-*-linux-x64.zip` / `*-linux-arm64.zip` |
   | macOS Intel / Apple Silicon | `BaiduPCS-Desktop-*-*-mac-x64.zip` / `*-mac-arm64.zip` |

4. 全部平台构建成功后自动发布 Release（tag 形如 `desktop-v2.2.5`）；已构建过的版本不会重复构建
5. 想立即构建：Actions → Auto Build → Run workflow（可填指定 tag）

> 注意：定时任务只在**默认分支**上运行，保持默认分支为包含本工作流的分支即可。

## 非 Windows 平台使用说明

- **Linux**：解压 zip 后进入目录执行 `./baidupcs-desktop`（或对应可执行文件）
- **macOS**：解压 zip，把 `BaiduPCS Desktop.app` 拖入 Applications。应用未签名（没有开发者证书），
  首次打开若提示"已损坏"或"无法验证开发者"，在终端执行：
  ```bash
  xattr -rd com.apple.quarantine "/Applications/BaiduPCS Desktop.app"
  ```
- 托盘图标在 macOS 上位于顶部菜单栏，右键（或 Ctrl+点击）可退出

## 免责声明

本项目只是 BaiduPCS-Rust 的桌面封装，使用第三方百度网盘客户端的账号风险请自行评估。
