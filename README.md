# BaiduPCS Desktop

[![Auto Build](https://github.com/willbon-dev/BaiduPCS-Desktop/actions/workflows/auto-build.yml/badge.svg)](https://github.com/willbon-dev/BaiduPCS-Desktop/actions/workflows/auto-build.yml)
[![Release](https://img.shields.io/github/v/release/willbon-dev/BaiduPCS-Desktop?include_prereleases)](https://github.com/willbon-dev/BaiduPCS-Desktop/releases)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[BaiduPCS-Rust](https://github.com/komorebiCarry/BaiduPCS-Rust) 的桌面应用封装。

上游是一个"Rust 后端 + 内置 Web 界面"的单文件网盘客户端，功能很全（文件管理、多线程下载、上传、转存、自动备份等），但官方形态需要自己开终端、记端口、开浏览器。本项目把它包成一个普通桌面应用：

- **双击即用**：启动后自动拉起后端、等待服务就绪、加载 Web 界面，全程无命令行黑窗口
- **关闭 = 退到托盘**：点关闭按钮直接销毁窗口（渲染进程退出、内存归还），托盘/菜单栏右键可完全退出
- **低资源占用**：全局禁用 GPU 进程；托盘态只剩 Electron 主进程（约 60~90MB）+ 后端本身
- **长列表分页**：上传/下载/转存/云下载/文件列表任务过多时自动分页，避免页面卡顿（壳层注入实现，不改上游任何代码）
- **跟随上游发版**：GitHub Actions 每 6 小时检查上游 release，有新版本自动五平台构建并发布

## 下载

到 [Releases](https://github.com/willbon-dev/BaiduPCS-Desktop/releases) 按平台下载：

| 平台 | 文件 | 使用方式 |
|---|---|---|
| Windows x64 | `BaiduPCS-Desktop-*-win-x64.zip` | 解压到任意目录，运行 `BaiduPCS Desktop.exe` |
| Linux x64 / ARM64 | `BaiduPCS-Desktop-*-linux-x64.zip` / `-arm64.zip` | 解压后运行 `./baidupcs-desktop` |
| macOS Intel / Apple Silicon | `BaiduPCS-Desktop-*-mac-x64.zip` / `-mac-arm64.zip` | 解压后把 `BaiduPCS Desktop.app` 拖入 Applications |

首次启动会在界面内扫码登录百度账号（登录逻辑属于上游，与本壳无关）。

> Windows 未做代码签名，SmartScreen 可能提示"已保护你的电脑"，点"更多信息 → 仍要运行"即可。

**macOS 提示"已损坏"或"无法验证开发者"**：应用未签名，去掉隔离标记后即可打开：

```bash
xattr -rd com.apple.quarantine "/Applications/BaiduPCS Desktop.app"
```

## 数据与配置

后端以上游的**便携式布局**运行：网盘数据与配置都放在后端程序旁边，不写注册表、不散落用户目录（壳的日志除外，见下）。以 Windows 为例，解压后的完整结构：

```
解压目录/
├── BaiduPCS Desktop.exe                 # 应用入口
├── resources/
│   ├── app.asar                         # 壳本身（Electron 代码）
│   └── backend/
│       ├── VERSION                      # 对应的上游版本号
│       └── BaiduPCS-Rust-v2.2.4-windows-x86_64/    ← 后端与数据都在这里
│           ├── baidu-netdisk-rust.exe   # 后端
│           ├── frontend/                # Web 界面（随包附带）
│           ├── config/app.toml          # 配置（随包附带，已按桌面场景微调，见下）
│           └── downloads/  data/  logs/  wal/      # 运行后生成
└── …（Electron 运行时文件：*.dll、locales/ 等）
```

macOS / Linux 结构一致：数据分别在 `BaiduPCS Desktop.app/Contents/Resources/backend/` 与解压目录的 `resources/backend/` 下。
因此**备份 / 搬迁 = 拷走整个 `resources/backend` 目录**；注意 macOS 把 app 拖入 Applications 后，数据也在 `.app` 包内部。

### config/app.toml 常用项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `server.port` | `18888` | 服务监听端口，壳会自动探测并连接 |
| `server.host` | `"0.0.0.0"` | 默认局域网可访问；介意就改成 `"127.0.0.1"`，或开启 `web_auth` |
| `download.download_dir` | `"downloads"` | 相对后端目录；也可写绝对路径 |
| `web_auth.enabled` / `mode` | `false` / `"none"` | 需要暴露公网时按上游文档开启密码 / TOTP |

两点说明：

- 构建时脚本会把 `filesystem.allowed_paths` 调整为 `[]`——上游默认指向 docker 的 `/data/uploads`，会限制桌面版的上传选择器目录；其余配置保持上游原样
- 修改配置后需要**完全退出**（托盘右键 → 退出）再打开才生效

### 升级须知

后端目录名自带版本号（`BaiduPCS-Rust-vX.Y.Z-…`），**升级到新版后是一个全新空目录**：登录状态与配置不会自动迁移。升级前如需保留，把旧目录的 `config/app.toml` 和 `downloads/` 拷贝到新目录即可（新包里附带的 `config/app.toml.example` 可用来对照字段是否有变化）。

壳自身的运行日志（启动后端、端口探测等）：用户数据目录下 `BaiduPCS Desktop/wrapper.log`
（Windows 在 `%APPDATA%`，macOS 在 `~/Library/Application Support`，Linux 在 `~/.config`）。

## 工作原理

```
启动 → 探测端口（app.toml 里的 port，依次尝试 18888 / 8080）
     ├─ 端口已有服务（比如你自己手动跑的后端）→ 直接复用，不重复启动，退出时也不会动它
     └─ 端口空闲 → 隐藏启动 backend/ 里的上游可执行文件（工作目录 = 程序目录）
        → 最多等 90 秒 → 加载 http://127.0.0.1:<port>/
```

- 单实例锁：重复双击只会唤起已有窗口
- 关闭窗口 = `destroy()` 而非隐藏，渲染进程即刻退出；托盘左键重开（页面状态在后端，重开无损失，登录态存在本地分区里不丢）
- 托盘右键菜单：打开主界面 / 退出（结束后端进程树：Windows `taskkill /T /F`，Unix 结束进程组）
- 后端意外退出会弹系统通知，重开窗口可自动重启

### 长列表分页是怎么做的

上游前端是一次性渲染全部任务的，任务多时布局/绘制开销会造成明显卡顿。本壳在页面里注入了一个 DOM 级分页器：

- 列表超过阈值（默认 100 条）时出现底部悬浮分页条，每页 100/200/500/不限 可选（记忆在 localStorage）
- 非当前页的行以 CSS 类隐藏，新插入的行默认隐藏，实时刷新进度不会闪屏
- 视口外的卡片附加 `content-visibility: auto`，即使不分页也跳过布局与绘制
- 覆盖：下载、上传、转存、云下载任务卡、网盘文件表格、云下载明细
- 它只操作 DOM、不碰上游代码，上游更新不受影响；将来上游若自带分页（列表变短），分页器会自动失效让位

## 从源码构建

环境：Node.js ≥ 22。国内镜像已内置（`.npmrc` 指向 npmmirror，Electron / electron-builder 二进制同步走镜像）。

```bash
git clone git@github.com:willbon-dev/BaiduPCS-Desktop.git
cd BaiduPCS-Desktop
npm install              # 安装依赖
npm run fetch-backend    # 下载上游后端到 backend/（直连失败自动切换加速代理）
npm start                # 本地运行
npm run dist             # 打包当前平台 zip 到 dist/
```

下载上游后端可指定版本与平台（CI 矩阵即通过这两个参数构建五平台）：

```bash
node scripts/fetch-backend.js --tag v2.2.4 --os linux --arch aarch64
# 国内网络仍慢时：GH_PROXY=https://ghfast.top node scripts/fetch-backend.js
```

其他脚本：

- `npm run gen-icon`：纯 Node 重新生成 `assets/` 下的图标（零依赖、不联网）
- `npm run smoke`：冒烟测试——真实启动应用并自动验证「页面加载 / 关闭到托盘 / 后端存活 / 退出清理」，
  输出 `smoke-window.png` 截图与 `smoke-result.json`。**会占用 18888 端口，请先关闭正在运行的实例**

## 自动构建

`.github/workflows/auto-build.yml`，三个阶段：

1. **check**：读取上游最新 release，若本仓库已存在对应 `desktop-<tag>` 则直接跳过
2. **build**：五平台矩阵并行（Windows / Ubuntu ×2 / macOS ×2；Linux ARM64 与 macOS Intel 为交叉打包，
   Electron 纯打包无原生编译，不需要对应架构真机），每平台下载对应架构的上游后端后打出 zip
3. **release**：五份产物全部成功后，汇总发布一个 Release（tag 形如 `desktop-v2.2.5`）

触发方式：定时（`17 */6 * * *`，即北京时间 08:17 / 14:17 / 20:17 / 02:17）或 Actions 页面手动 Run workflow（可填指定 tag 补旧版本）。

注意事项：

- 定时任务只在默认分支上生效
- 仓库 60 天无提交后 GitHub 会暂停定时工作流（会发邮件提醒），任意提交即可恢复
- 若发布阶段报 403：Settings → Actions → General → Workflow permissions 改为 Read and write permissions
  （工作流内已显式声明 `contents: write`，一般无需改动）

## 项目结构

```
baidupcs-desktop/
├── main.js                  # Electron 主进程：后端生命周期 / 托盘 / 窗口 / 端口探测 / 冒烟钩子
├── preload.js               # 壳层注入：诊断信息桥 + 长列表分页器
├── loading.html / error.html
├── assets/                  # 图标（scripts/gen-icon.js 纯代码生成，含 Windows ICO 与 macOS 托盘 @2x）
├── backend/                 # 构建时由 fetch-backend 填充上游可执行文件（不入库）
├── scripts/
│   ├── fetch-backend.js     # 按平台下载上游发布包（release API 匹配资产 + 国内加速代理回退）
│   ├── gen-icon.js          # 纯 Node 生成 PNG/ICO 图标
│   ├── set-version.js       # CI 同步上游版本号
│   └── smoke.js             # 冒烟测试入口
└── .github/workflows/auto-build.yml
```

## 致谢与声明

- 核心能力全部来自上游 [komorebiCarry/BaiduPCS-Rust](https://github.com/komorebiCarry/BaiduPCS-Rust)，本项目只是桌面壳
- 使用第三方百度网盘客户端存在账号风险，请自行评估
- 本项目以 [Apache-2.0](LICENSE) 许可开源
