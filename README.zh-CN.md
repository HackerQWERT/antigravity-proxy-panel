# Antigravity Proxy Panel

给 **Google Antigravity** 一个专属代理，**不影响 VS Code 全局代理设置，也不影响其他扩展**。

它在 Antigravity 侧边栏里装一个小面板，负责管理你自己的代理/VLESS 订阅和 xray 进程，并对官方 Antigravity 扩展打一个运行时 patch，让它启动的 `agy` 后端把所有出站流量走这个代理。

> **范围：** 本项目只处理**网络**。鉴权、模型、Agent 等一切逻辑，100% 保留在官方 Google Antigravity 扩展里，本项目不修改鉴权。

## 工作原理

```
Proxy 面板（本扩展）
  │  Start → 在 127.0.0.1:<随机端口> 启动 xray
  │  写入 antigravityProxy.url = http://127.0.0.1:<端口>
  ▼
官方 Antigravity 扩展（已 patch）
  │  构造 agy 环境时读取 antigravityProxy.url
  └─ 给 agy 子进程设置 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
       ▼
agy 后端  →  本地 xray  →  你的代理节点（例如美国）
```

- patch 是在**运行时对已安装的扩展文件**打的——不分叉、不重新打包 Google 的代码。
- 其他扩展不受影响：它们不会读 `antigravityProxy.url`。
- VS Code 的 `http.proxy` 可以保持 `off`。
- 面板里有一键 **Apply Patch / Remove Patch**，patcher 是幂等的，会自动备份 `.bak`。
- Antigravity 更新后，重新点一次 Apply Patch 即可（面板会自动识别新版本）。

## 功能

- Antigravity 活动栏里的侧边栏面板
- 订阅 URL 管理（3x-ui / v2board / base64 分享链接列表）
- 节点列表与选择（VLESS + Reality / TLS，TCP / WS / gRPC）
- 自动下载 xray（SHA-256 校验）并管理进程
- Start / Stop、实时状态、输出日志频道
- Apply / Remove patch，带版本检测和备份
- 运行时零依赖（只用 Node 内置模块）

## 安装（源码方式）

```bash
git clone https://github.com/HackerQWERT/antigravity-proxy-panel.git
cd antigravity-proxy-panel
npm install -g @vscode/vsce
vsce package
code --install-extension antigravity-proxy-panel-*.vsix
```

或直接把目录复制到扩展目录：

```
~/.vscode/extensions/hackerqwert.antigravity-proxy-panel-0.1.0/
```

## 使用

1. 点活动栏的 **Antigravity** 图标 → **Proxy** 面板。
2. 首次使用：**Apply Patch**，按提示 Reload 窗口。
3. 粘贴订阅 URL → **Save URL** → **Refresh**。
4. 选择一个节点（例如美国节点）→ **Start**。
5. Reload 窗口，让 `agy` 后端拿到新代理。

之后 Antigravity 后端流量就走所选节点。登录和账号逻辑仍完全由 Google 官方处理。

## 环境要求

- VS Code 1.85+
- 已安装 Google Antigravity 扩展（`Google.google-antigravity`）
- 返回 VLESS 分享链接的订阅（base64 或纯文本）

## 支持的节点

| 协议 | 传输 | 安全 |
|---|---|---|
| VLESS | TCP / WS / gRPC | Reality / TLS / none |

更多协议可在 `subscription.js` 中扩展。

## 注意事项

- patch 会修改已安装 Antigravity 扩展里的 `extension.js`。Antigravity 更新会恢复原文件——在面板里重新 Apply Patch 即可。
- patcher 针对 Antigravity 1.12.0 的 `le()` 函数。如果 Google 改了这段代码，patcher 会明确报错，而不是静默失败。
- xray 首次 Start 时下载（支持 Linux/Windows/macOS），存放在扩展的 global storage 里。
- 本项目不绕过账号资格、许可或服务条款，只把你控制的代理用于网络路由。

## 许可证

MIT
