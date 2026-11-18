#!/usr/bin/env python3
"""
给 Antigravity 扩展打 patch：让它读 antigravityProxy.url 作为专属代理
用法: python3 apply-patch.py [extension.js 路径]
"""
import sys
import os

import glob

def find_extension_js():
    """自动探测常见安装位置"""
    home = os.path.expanduser("~")
    patterns = [
        os.path.join(home, ".vscode", "extensions", "google.google-antigravity-*", "extension.js"),
        os.path.join(home, ".vscode-server", "extensions", "google.google-antigravity-*", "extension.js"),
        os.path.join(home, ".vscode-insiders", "extensions", "google.google-antigravity-*", "extension.js"),
    ]
    matches = []
    for p in patterns:
        matches.extend(glob.glob(p))
    matches.sort(key=os.path.getmtime, reverse=True)
    return matches[0] if matches else None
PATCH_MARKER = 'ANTIGRAVITY PROXY OVERRIDE'

NEW_LE = '''function le(a,b){
// ============ ANTIGRAVITY PROXY OVERRIDE (custom patch) ============
// 读取自定义配置 antigravityProxy.url，不走 http.proxy
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
    // 配置读取失败时静默回退到原逻辑
}
// ============ END CUSTOM PATCH ============
var c=b==null?void 0:b.get("proxySupport");if((typeof c==="string"?c.trim().toLowerCase():void 0)==="off")delete a.HTTP_PROXY,delete a.http_proxy,delete a.HTTPS_PROXY,delete a.https_proxy,delete a.ALL_PROXY,delete a.all_proxy,delete a.AGY_LLM_GATEWAY_PROXY_URL,delete a[Kd.AGY_PROXY_STRICT_SSL_ENV],a.NO_PROXY="*",a.no_proxy="*";else{c=b==null?void 0:b.get("proxy");c=typeof c==="string"&&c.trim()?c.trim():void 0;var d=a.HTTPS_PROXY||a.https_proxy||a.HTTP_PROXY||a.http_proxy||a.ALL_PROXY||
a.all_proxy,g=typeof d==="string"&&d.trim()?d.trim():void 0;d=c!=null?c:g;c?(a.HTTP_PROXY=c,a.http_proxy=c,a.HTTPS_PROXY=c,a.https_proxy=c):g&&(a.HTTP_PROXY||a.http_proxy||(a.HTTP_PROXY=g,a.http_proxy=g),a.HTTPS_PROXY||a.https_proxy||(a.HTTPS_PROXY=g,a.https_proxy=g));if((g=je(b==null?void 0:b.get("noProxy")))||d){var h=[a.NO_PROXY||a.no_proxy,g].filter(Boolean).join(",");if(h&&h.trim()){g=new Set;var m=[];for(p of h.split(",")){h=p.trim();if(!h)continue;let q=h.toLowerCase();g.has(q)||(g.add(q),
m.push(h))}if(!g.has("*"))for(let q of["localhost","127.0.0.1","::1"])g.has(q)||(g.add(q),m.push(q));var p=m.join(",")}else p="localhost,127.0.0.1,::1";a.NO_PROXY=p;a.no_proxy=p}b=b==null?void 0:b.get("proxyStrictSSL");d&&b!==!0?b===!1&&(a[Kd.AGY_PROXY_STRICT_SSL_ENV]="false"):delete a[Kd.AGY_PROXY_STRICT_SSL_ENV];return c}}

'''

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else find_extension_js()
    if not path:
        print('ERROR: 找不到 Antigravity 扩展，请把 extension.js 路径作为参数传入')
        sys.exit(1)

    if not os.path.exists(path):
        print(f"ERROR: 文件不存在: {path}")
        sys.exit(1)

    with open(path, 'r') as f:
        content = f.read()

    # 检查是否已 patch
    if PATCH_MARKER in content:
        print(f"⚠️  已存在 patch，跳过")
        sys.exit(0)

    # 定位 le 函数
    target = 'function le(a,b){var c=b==null?void 0:b.get("proxySupport")'
    idx = content.find(target)
    if idx == -1:
        print(f"ERROR: 找不到 le 函数（可能 Antigravity 版本变了）")
        sys.exit(1)

    # 找函数结束（下一个 function me( 开始）
    end = content.find('function me(', idx)
    if end == -1:
        print(f"ERROR: 找不到函数结束")
        sys.exit(1)

    # 备份
    bak_path = path + '.bak'
    if not os.path.exists(bak_path):
        with open(bak_path, 'w') as f:
            f.write(content)
        print(f"✅ 备份到 {bak_path}")

    # 替换
    new_content = content[:idx] + NEW_LE + content[end:]

    with open(path, 'w') as f:
        f.write(new_content)

    print(f"✅ Patch 已应用: {path}")
    print(f"   原大小: {len(content)} bytes")
    print(f"   新大小: {len(new_content)} bytes")

if __name__ == '__main__':
    main()
