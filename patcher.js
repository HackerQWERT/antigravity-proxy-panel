// patcher.js
// 负责给 Antigravity 扩展打 patch / 移除 patch

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const PATCH_MARKER = 'ANTIGRAVITY PROXY OVERRIDE';

const NEW_LE = `function le(a,b){
// ============ ANTIGRAVITY PROXY OVERRIDE (custom patch) ============
try {
    var customCfg = n.workspace.getConfiguration("antigravityProxy");
    var customProxy = customCfg ? customCfg.get("url") : null;
    if (typeof customProxy === "string" && customProxy.trim()) {
        var cp = customProxy.trim();
        a.HTTP_PROXY = cp;
        a.http_proxy = cp;
        a.HTTPS_PROXY = cp;
        a.https_proxy = cp;
        a.ALL_PROXY = cp;
        a.all_proxy = cp;
        var customNoProxy = customCfg.get("noProxy");
        if (typeof customNoProxy === "string" && customNoProxy.trim()) {
            a.NO_PROXY = customNoProxy.trim();
            a.no_proxy = customNoProxy.trim();
        } else {
            a.NO_PROXY = "localhost,127.0.0.1,::1";
            a.no_proxy = "localhost,127.0.0.1,::1";
        }
        var customStrictSSL = customCfg.get("strictSSL");
        if (customStrictSSL === false) {
            a[Kd.AGY_PROXY_STRICT_SSL_ENV] = "false";
        } else {
            delete a[Kd.AGY_PROXY_STRICT_SSL_ENV];
        }
        return cp;
    }
} catch (e) {
    // fallback to original logic
}
// ============ END CUSTOM PATCH ============
var c=b==null?void 0:b.get("proxySupport");if((typeof c==="string"?c.trim().toLowerCase():void 0)==="off")delete a.HTTP_PROXY,delete a.http_proxy,delete a.HTTPS_PROXY,delete a.https_proxy,delete a.ALL_PROXY,delete a.all_proxy,delete a.AGY_LLM_GATEWAY_PROXY_URL,delete a[Kd.AGY_PROXY_STRICT_SSL_ENV],a.NO_PROXY="*",a.no_proxy="*";else{c=b==null?void 0:b.get("proxy");c=typeof c==="string"&&c.trim()?c.trim():void 0;var d=a.HTTPS_PROXY||a.https_proxy||a.HTTP_PROXY||a.http_proxy||a.ALL_PROXY||
a.all_proxy,g=typeof d==="string"&&d.trim()?d.trim():void 0;d=c!=null?c:g;c?(a.HTTP_PROXY=c,a.http_proxy=c,a.HTTPS_PROXY=c,a.https_proxy=c):g&&(a.HTTP_PROXY||a.http_proxy||(a.HTTP_PROXY=g,a.http_proxy=g),a.HTTPS_PROXY||a.https_proxy||(a.HTTPS_PROXY=g,a.https_proxy=g));if((g=je(b==null?void 0:b.get("noProxy")))||d){var h=[a.NO_PROXY||a.no_proxy,g].filter(Boolean).join(",");if(h&&h.trim()){g=new Set;var m=[];for(p of h.split(",")){h=p.trim();if(!h)continue;let q=h.toLowerCase();g.has(q)||(g.add(q),
m.push(h))}if(!g.has("*"))for(let q of["localhost","127.0.0.1","::1"])g.has(q)||(g.add(q),m.push(q));var p=m.join(",")}else p="localhost,127.0.0.1,::1";a.NO_PROXY=p;a.no_proxy=p}b=b==null?void 0:b.get("proxyStrictSSL");d&&b!==!0?b===!1&&(a[Kd.AGY_PROXY_STRICT_SSL_ENV]="false"):delete a[Kd.AGY_PROXY_STRICT_SSL_ENV];return c}}

`;

const ORIGINAL_LE_START = 'function le(a,b){var c=b==null?void 0:b.get("proxySupport")';
const LE_END_MARKER = 'function me(';

/**
 * 查找 Antigravity 扩展的安装位置
 * @returns {{found: boolean, extPath?: string, version?: string, extensionJs?: string}}
 */
function findAntigravity() {
    // 通过 VSCode API 拿扩展路径
    const ext = vscode.extensions.getExtension('Google.google-antigravity');
    if (!ext) {
        return { found: false };
    }
    const extPath = ext.extensionUri.fsPath;
    const extensionJs = path.join(extPath, 'extension.js');
    return {
        found: true,
        extPath,
        extensionJs,
        version: ext.packageJSON.version
    };
}

/**
 * 检查 patch 状态
 * @returns {{status: 'not_installed'|'clean'|'patched'|'unknown', extPath?, version?, bakExists?}}
 */
function checkPatchStatus() {
    const info = findAntigravity();
    if (!info.found) {
        return { status: 'not_installed' };
    }
    if (!fs.existsSync(info.extensionJs)) {
        return { status: 'unknown', extPath: info.extPath, version: info.version };
    }
    const content = fs.readFileSync(info.extensionJs, 'utf8');
    const bakExists = fs.existsSync(info.extensionJs + '.bak');
    const hasPatch = content.includes(PATCH_MARKER);
    return {
        status: hasPatch ? 'patched' : 'clean',
        extPath: info.extPath,
        extensionJs: info.extensionJs,
        version: info.version,
        bakExists
    };
}

/**
 * 应用 patch
 * @returns {{ok: boolean, message: string}}
 */
function applyPatch() {
    const status = checkPatchStatus();
    if (status.status === 'not_installed') {
        return { ok: false, message: 'Google Antigravity extension is not installed.' };
    }
    if (status.status === 'patched') {
        return { ok: true, message: 'Already patched.' };
    }

    const content = fs.readFileSync(status.extensionJs, 'utf8');
    const idx = content.indexOf(ORIGINAL_LE_START);
    if (idx === -1) {
        return {
            ok: false,
            message: `Cannot find le() function. Antigravity v${status.version} may have changed its internal structure.`
        };
    }
    const end = content.indexOf(LE_END_MARKER, idx);
    if (end === -1) {
        return { ok: false, message: 'Cannot find function end marker.' };
    }

    // 备份
    const bakPath = status.extensionJs + '.bak';
    if (!fs.existsSync(bakPath)) {
        fs.writeFileSync(bakPath, content);
    }

    const newContent = content.slice(0, idx) + NEW_LE + content.slice(end);
    try {
        fs.writeFileSync(status.extensionJs, newContent);
    } catch (err) {
        return { ok: false, message: `Failed to write: ${err.message}` };
    }

    return { ok: true, message: `Patched successfully (v${status.version}).` };
}

/**
 * 移除 patch（恢复 .bak）
 * @returns {{ok: boolean, message: string}}
 */
function removePatch() {
    const status = checkPatchStatus();
    if (status.status === 'not_installed') {
        return { ok: false, message: 'Google Antigravity extension is not installed.' };
    }
    if (status.status !== 'patched') {
        return { ok: true, message: 'Not patched, nothing to do.' };
    }
    const bakPath = status.extensionJs + '.bak';
    if (!fs.existsSync(bakPath)) {
        return { ok: false, message: 'No .bak file found. Cannot restore.' };
    }
    fs.copyFileSync(bakPath, status.extensionJs);
    return { ok: true, message: 'Patch removed, restored from .bak.' };
}

module.exports = { checkPatchStatus, applyPatch, removePatch };
