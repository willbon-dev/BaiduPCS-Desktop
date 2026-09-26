# backend 目录说明

此目录用于存放 BaiduPCS-Rust 的 Windows 可执行文件（由构建脚本自动下载填充，**不要手动提交二进制**）。

填充方式（任选其一）：

```bash
# 自动下载最新版（国内网络会自动尝试加速代理，也可手动指定）
npm run fetch-backend

# 指定版本
node scripts/fetch-backend.js --tag v2.2.4

# 手动指定 GitHub 加速代理
GH_PROXY=https://ghfast.top node scripts/fetch-backend.js --tag v2.2.4
```

CI（GitHub Actions）构建时会自动下载对应版本并放入此目录，因此仓库里永远只有这个说明文件。
