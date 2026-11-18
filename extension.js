// extension.js
// Antigravity Proxy Panel - main extension

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { ensureXray, startXray } = require('./xray-manager');
const { listNodes, pickOutboundByName } = require('./subscription');
const { checkPatchStatus, applyPatch, removePatch } = require('./patcher');

let outputChannel;
let xrayHandle = null;
let panelProvider = null;
let currentState = {
    status: 'stopped',       // stopped | starting | running | error
    error: null,
    proxyUrl: null,
    port: null,
    selectedNode: null,
    nodes: [],
    subscriptionUrl: '',
    lastRefresh: null,
    patchStatus: null        // 由 checkPatchStatus 填充
};

function log(msg) {
    if (outputChannel) {
        const ts = new Date().toISOString();
        outputChannel.appendLine(`[${ts}] ${msg}`);
    }
}

function refreshPatchStatus() {
    try {
        currentState.patchStatus = checkPatchStatus();
    } catch (err) {
        currentState.patchStatus = { status: 'unknown', error: err.message };
    }
}


function setState(patch) {
    Object.assign(currentState, patch);
    if (panelProvider) {
        panelProvider.update();
    }
}

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https:') ? https : http;
        mod.get(url, { headers: { 'User-Agent': 'antigravity-proxy-panel' }, timeout: 20000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(fetchText(res.headers.location));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
    });
}

async function refreshSubscription(context) {
    const config = vscode.workspace.getConfiguration('antigravityProxy');
    const url = (config.get('subscriptionUrl') || '').trim();
    if (!url) {
        vscode.window.showWarningMessage('Please set subscription URL first.');
        return;
    }
    log(`Fetching subscription: ${url}`);
    try {
        const raw = await fetchText(url);
        const nodes = listNodes(raw);
        log(`Got ${nodes.length} vless nodes`);
        setState({
            nodes,
            subscriptionUrl: url,
            lastRefresh: new Date().toISOString(),
            error: null
        });
        await context.globalState.update('cachedNodes', nodes);
        await context.globalState.update('cachedRaw', raw);
    } catch (err) {
        log(`Refresh failed: ${err.message}`);
        setState({ error: `Refresh failed: ${err.message}` });
    }
}

async function startProxy(context, nodeName) {
    if (xrayHandle) {
        log('xray already running, stopping first');
        await stopProxy();
    }
    setState({ status: 'starting', error: null });
    try {
        const config = vscode.workspace.getConfiguration('antigravityProxy');
        const url = (config.get('subscriptionUrl') || '').trim();
        if (!url) throw new Error('No subscription URL configured');

        log(`Fetching subscription to pick node "${nodeName}"...`);
        const raw = await fetchText(url);
        const picked = pickOutboundByName(raw, nodeName);
        log(`Picked node: ${picked.nodeName}`);

        const binDir = context.globalStorageUri.fsPath;
        fs.mkdirSync(binDir, { recursive: true });
        log('Ensuring xray binary...');
        const xrayPath = await ensureXray(binDir, log);

        log('Starting xray...');
        xrayHandle = await startXray({
            binPath: xrayPath,
            outbound: picked.outbound,
            listenHost: '127.0.0.1',
            listenPort: 0,
            workDir: binDir,
            log
        });

        const proxyUrl = `http://127.0.0.1:${xrayHandle.port}`;
        log(`xray running on ${proxyUrl}`);

        await config.update('url', proxyUrl, vscode.ConfigurationTarget.Global);
        await config.update('selectedNodeName', nodeName, vscode.ConfigurationTarget.Global);

        setState({
            status: 'running',
            proxyUrl,
            port: xrayHandle.port,
            selectedNode: nodeName,
            error: null
        });

        // 提示重新加载 Antigravity 让 patch 生效
        vscode.window.showInformationMessage(
            `Proxy started on ${proxyUrl}. Reload window for Antigravity to use it.`,
            'Reload Window'
        ).then(choice => {
            if (choice === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    } catch (err) {
        log(`Start failed: ${err.message}`);
        setState({ status: 'error', error: err.message });
        vscode.window.showErrorMessage(`Antigravity Proxy: ${err.message}`);
    }
}

async function stopProxy() {
    if (xrayHandle) {
        log('Stopping xray...');
        await xrayHandle.stop();
        xrayHandle = null;
    }
    const config = vscode.workspace.getConfiguration('antigravityProxy');
    await config.update('url', '', vscode.ConfigurationTarget.Global);
    setState({
        status: 'stopped',
        proxyUrl: null,
        port: null,
        error: null
    });
    log('Proxy stopped');
}

class ProxyPanelProvider {
    constructor(context) {
        this.context = context;
        this.view = null;
    }

    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')]
        };
        view.webview.html = this.renderHtml();
        view.webview.onDidReceiveMessage(async msg => {
            log(`Webview message: ${JSON.stringify(msg)}`);
            switch (msg.command) {
                case 'refresh':
                    await vscode.commands.executeCommand('antigravityProxy.refresh');
                    break;
                case 'start':
                    await startProxy(this.context, msg.nodeName);
                    break;
                case 'stop':
                    await stopProxy();
                    break;
                case 'setSubscriptionUrl':
                    await vscode.workspace.getConfiguration('antigravityProxy')
                        .update('subscriptionUrl', msg.url, vscode.ConfigurationTarget.Global);
                    setState({ subscriptionUrl: msg.url });
                    break;
                case 'applyPatch':
                    await vscode.commands.executeCommand('antigravityProxy.applyPatch');
                    break;
                case 'removePatch':
                    await vscode.commands.executeCommand('antigravityProxy.removePatch');
                    break;
            }
        });
        this.update();
    }

    update() {
        if (this.view) {
            this.view.webview.html = this.renderHtml();
        }
    }

    renderHtml() {
        const s = currentState;
        const p = s.patchStatus || { status: 'unknown' };
        const esc = str => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const statusColor = {
            stopped: '#888',
            starting: '#f90',
            running: '#4c4',
            error: '#e44'
        }[s.status] || '#888';

        const statusDot = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${statusColor};margin-right:6px;"></span>`;

        // Patch 状态区
        let patchHtml = '';
        if (p.status === 'not_installed') {
            patchHtml = `
                <div class="error">Google Antigravity extension is not installed.</div>
            `;
        } else if (p.status === 'clean') {
            patchHtml = `
                <div class="patch-status clean">
                    <span style="color:#f90;">●</span> Not patched (v${esc(p.version)})
                    <button onclick="applyPatch()" style="margin-left:8px;">Apply Patch</button>
                </div>
            `;
        } else if (p.status === 'patched') {
            patchHtml = `
                <div class="patch-status patched">
                    <span style="color:#4c4;">●</span> Patched (v${esc(p.version)})
                    <button class="secondary" onclick="removePatch()" style="margin-left:8px;">Remove</button>
                </div>
            `;
        } else {
            patchHtml = `
                <div class="patch-status unknown">
                    <span style="color:#888;">●</span> Unknown
                    <button class="secondary" onclick="applyPatch()" style="margin-left:8px;">Retry</button>
                </div>
            `;
        }

        const nodesHtml = s.nodes.length === 0
            ? `<p style="opacity:0.6;font-size:12px;">No nodes. Set subscription URL and click Refresh.</p>`
            : s.nodes.map(n => `
                <div class="node ${s.selectedNode === n.name ? 'selected' : ''}" data-name="${esc(n.name)}">
                    <div class="node-name">${esc(n.name)}</div>
                    <div class="node-meta">${esc(n.host)}:${n.port} · ${esc(n.security)}</div>
                </div>
            `).join('');

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        padding: 12px;
        font-size: 13px;
    }
    h3 { margin: 0 0 8px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; opacity: 0.7; letter-spacing: 0.5px; }
    .section { margin-bottom: 16px; }
    input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        padding: 4px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        font-family: var(--vscode-font-family);
        font-size: 12px;
    }
    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 4px 10px;
        cursor: pointer;
        border-radius: 2px;
        margin-right: 4px;
        font-family: var(--vscode-font-family);
        font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status {
        display: flex;
        align-items: center;
        padding: 8px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 4px;
        margin-bottom: 8px;
    }
    .patch-status {
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .patch-status.clean { background: rgba(255,153,0,0.1); }
    .patch-status.patched { background: rgba(68,204,68,0.1); }
    .node {
        padding: 6px 8px;
        border: 1px solid var(--vscode-panel-border, transparent);
        border-radius: 4px;
        margin-bottom: 4px;
        cursor: pointer;
    }
    .node:hover { background: var(--vscode-list-hoverBackground); }
    .node.selected {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
    }
    .node-name { font-weight: 600; margin-bottom: 2px; font-size: 12px; }
    .node-meta { font-size: 11px; opacity: 0.7; }
    .error {
        background: var(--vscode-inputValidation-errorBackground);
        border: 1px solid var(--vscode-inputValidation-errorBorder);
        color: var(--vscode-inputValidation-errorForeground);
        padding: 8px;
        border-radius: 4px;
        margin-bottom: 8px;
        font-size: 12px;
    }
    .meta { font-size: 11px; opacity: 0.7; margin-top: 8px; }
    .proxy-url {
        font-family: var(--vscode-editor-font-family, monospace);
        background: var(--vscode-textCodeBlock-background);
        padding: 4px 6px;
        border-radius: 2px;
        font-size: 11px;
        word-break: break-all;
        margin-top: 4px;
    }
</style>
</head>
<body>
    <div class="section">
        <h3>Patch Status</h3>
        ${patchHtml}
    </div>

    <div class="section">
        <h3>Proxy Status</h3>
        <div class="status">
            ${statusDot}
            <div style="flex:1;">
                <div><strong>${esc(s.status.toUpperCase())}</strong></div>
                ${s.proxyUrl ? `<div class="proxy-url">${esc(s.proxyUrl)}</div>` : ''}
                ${s.selectedNode ? `<div style="font-size:11px;opacity:0.7;margin-top:2px;">${esc(s.selectedNode)}</div>` : ''}
            </div>
        </div>
        ${s.error ? `<div class="error">${esc(s.error)}</div>` : ''}
        ${s.status === 'running'
            ? `<button onclick="stop()">Stop</button>`
            : `<button onclick="start()" ${!s.selectedNode ? 'disabled' : ''}>Start</button>`
        }
        <button class="secondary" onclick="refresh()">Refresh</button>
    </div>

    <div class="section">
        <h3>Subscription</h3>
        <input type="text" id="subUrl" placeholder="https://your-3x-ui.com/sub/..." value="${esc(s.subscriptionUrl)}" />
        <div style="margin-top:4px;">
            <button class="secondary" onclick="saveUrl()">Save URL</button>
        </div>
        ${s.lastRefresh ? `<div class="meta">Last refresh: ${esc(new Date(s.lastRefresh).toLocaleString())}</div>` : ''}
    </div>

    <div class="section">
        <h3>Nodes (${s.nodes.length})</h3>
        ${nodesHtml}
    </div>

<script>
    const vscode = acquireVsCodeApi();

    function refresh() { vscode.postMessage({ command: 'refresh' }); }
    function start() {
        const sel = document.querySelector('.node.selected');
        if (!sel) return;
        vscode.postMessage({ command: 'start', nodeName: sel.dataset.name });
    }
    function stop() { vscode.postMessage({ command: 'stop' }); }
    function saveUrl() {
        const url = document.getElementById('subUrl').value.trim();
        vscode.postMessage({ command: 'setSubscriptionUrl', url });
    }
    function applyPatch() { vscode.postMessage({ command: 'applyPatch' }); }
    function removePatch() { vscode.postMessage({ command: 'removePatch' }); }

    document.querySelectorAll('.node').forEach(el => {
        el.addEventListener('click', () => {
            document.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
            el.classList.add('selected');
        });
        el.addEventListener('dblclick', () => {
            document.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
            el.classList.add('selected');
            start();
        });
    });
</script>
</body>
</html>`;
    }
}

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Antigravity Proxy');
    log('Extension activating...');

    // 初始化状态
    refreshPatchStatus();

    const cachedNodes = context.globalState.get('cachedNodes', []);
    const config = vscode.workspace.getConfiguration('antigravityProxy');
    const savedUrl = config.get('subscriptionUrl') || '';
    const savedNode = config.get('selectedNodeName') || '';
    const savedProxyUrl = config.get('url') || '';

    setState({
        nodes: cachedNodes,
        subscriptionUrl: savedUrl,
        selectedNode: savedNode || null,
        status: savedProxyUrl ? 'running' : 'stopped',
        proxyUrl: savedProxyUrl || null
    });

    // 注册 webview provider
    panelProvider = new ProxyPanelProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'antigravityProxy.panel',
            panelProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityProxy.refresh', async () => {
            await refreshSubscription(context);
        }),
        vscode.commands.registerCommand('antigravityProxy.start', async () => {
            if (!currentState.selectedNode) {
                vscode.window.showWarningMessage('Select a node first.');
                return;
            }
            await startProxy(context, currentState.selectedNode);
        }),
        vscode.commands.registerCommand('antigravityProxy.stop', async () => {
            await stopProxy();
        }),
        vscode.commands.registerCommand('antigravityProxy.applyPatch', async () => {
            log('Applying patch...');
            const result = applyPatch();
            log(`Patch result: ${result.message}`);
            if (result.ok) {
                vscode.window.showInformationMessage(
                    result.message + ' Reload window to activate.',
                    'Reload Window'
                ).then(c => {
                    if (c === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else {
                vscode.window.showErrorMessage(result.message);
            }
            refreshPatchStatus();
            if (panelProvider) panelProvider.update();
        }),
        vscode.commands.registerCommand('antigravityProxy.removePatch', async () => {
            log('Removing patch...');
            const result = removePatch();
            log(`Remove result: ${result.message}`);
            if (result.ok) {
                vscode.window.showInformationMessage(
                    result.message + ' Reload window to apply.',
                    'Reload Window'
                ).then(c => {
                    if (c === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else {
                vscode.window.showErrorMessage(result.message);
            }
            refreshPatchStatus();
            if (panelProvider) panelProvider.update();
        })
    );

    // 清理
    context.subscriptions.push({
        dispose: async () => {
            if (xrayHandle) {
                await xrayHandle.stop();
                xrayHandle = null;
            }
        }
    });

    log('Extension activated.');
}

async function deactivate() {
    if (xrayHandle) {
        await xrayHandle.stop();
        xrayHandle = null;
    }
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
