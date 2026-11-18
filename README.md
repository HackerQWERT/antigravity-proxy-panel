# Antigravity Proxy Panel

**English** · [简体中文](README.zh-CN.md)

A VS Code extension that gives **Google Antigravity** a dedicated proxy — without touching VS Code's global proxy settings.

It installs a tiny webview panel inside the Antigravity sidebar, manages your own proxy/VLESS subscription and xray process, and patches the official Antigravity extension so its `agy` backend routes all traffic through that proxy.

> **Scope:** this project only handles *networking*. Authentication, models, agents, and everything else stay 100% with the official Google Antigravity extension.

## How it works

```
Proxy Panel (this extension)
  │  Start → spawns xray on 127.0.0.1:<random port>
  │  writes  antigravityProxy.url = http://127.0.0.1:<port>
  ▼
Official Antigravity extension (patched)
  │  reads antigravityProxy.url when building the agy environment
  └─ sets HTTP_PROXY / HTTPS_PROXY / ALL_PROXY for the agy child process
       ▼
agy backend  →  local xray  →  your proxy node (e.g. US)
```

- The patch is applied at **runtime to the installed extension files** — no fork, no repackaging of Google's code.
- Other extensions are not affected: they never read `antigravityProxy.url`.
- VS Code's `http.proxy` setting can stay `off`.
- A one-click **Apply Patch / Remove Patch** is available in the panel, and the patcher is idempotent and makes a `.bak` backup.
- Re-applying after an Antigravity update takes one click (the panel detects the new version).

## Features

- Sidebar panel inside the Antigravity activity bar
- Subscription URL management (3x-ui / v2board / base64 share-link lists)
- Node list with selection (VLESS + Reality / TLS, TCP / WS / gRPC)
- Automatic xray download (SHA-256 verified) and lifecycle management
- Start / Stop, live status, output log channel
- Apply / Remove patch with version detection and backup
- Zero runtime dependencies (Node built-ins only)

## Install (from source)

```bash
git clone https://github.com/HackerQWERT/antigravity-proxy-panel.git
cd antigravity-proxy-panel
npm install -g @vscode/vsce
vsce package
code --install-extension antigravity-proxy-panel-*.vsix
```

Or copy the folder to your extensions directory:

```
~/.vscode/extensions/hackerqwert.antigravity-proxy-panel-0.1.0/
```

## Usage

1. Open the **Antigravity** icon in the activity bar → **Proxy** panel.
2. **Apply Patch** (first time only). Reload the window when prompted.
3. Paste your subscription URL → **Save URL** → **Refresh**.
4. Select a node (e.g. a US node) → **Start**.
5. Reload the window so the `agy` backend picks up the new proxy.

After that, Antigravity's backend traffic goes through the selected node. Sign-in and account logic remain fully Google's.

## Requirements

- VS Code 1.85+
- Google Antigravity extension installed (`Google.google-antigravity`)
- A subscription that returns VLESS share links (base64 or plain text)

## Supported nodes

| Protocol | Transport | Security |
|---|---|---|
| VLESS | TCP / WS / gRPC | Reality / TLS / none |

More protocols can be added in `subscription.js`.

## Notes & limitations

- Patching modifies `extension.js` inside the installed Antigravity extension. Updating Antigravity restores the original file — re-apply the patch from the panel.
- The patcher targets the `le()` function in Antigravity 1.12.0. If Google changes that code, the patcher reports an explicit error instead of failing silently.
- xray is downloaded on first Start (Linux/Windows/macOS supported) and stored in the extension's global storage.
- This project does not bypass account eligibility, licensing, or terms of service. It only routes network traffic through a proxy you control.

## License

MIT
