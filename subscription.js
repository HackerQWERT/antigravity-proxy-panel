// subscription.js
// 解析 3x-ui / 通用订阅内容，筛选节点，生成 xray outbound 配置
// 零依赖，只用 Node 内置模块

/**
 * 解码订阅文本：可能是 base64 编码的多行分享链接，也可能是纯文本
 * @param {string} raw
 * @returns {string[]} 分享链接数组（vless://、vmess://、trojan:// 等）
 */
function decodeSubscription(raw) {
    const text = raw.trim();
    // 如果已经包含 vless:// 等，说明不是 base64
    if (/^(vless|vmess|trojan|ss):\/\//m.test(text)) {
        return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    }
    // 尝试 base64 解码
    try {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        if (/^(vless|vmess|trojan|ss):\/\//m.test(decoded)) {
            return decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        }
    } catch { /* fallthrough */ }
    throw new Error('无法解析订阅内容：既不是分享链接列表，也不是有效的 base64 订阅');
}

/**
 * 解析单条 vless:// 分享链接为结构化节点
 * @param {string} link
 */
function parseVless(link) {
    const url = new URL(link);
    if (url.protocol !== 'vless:') {
        throw new Error(`不支持的协议: ${url.protocol}`);
    }
    const uuid = url.username;
    const host = url.hostname;
    const port = parseInt(url.port || '443', 10);
    const params = url.searchParams;
    const name = decodeURIComponent(url.hash.replace(/^#/, ''));

    return {
        type: 'vless',
        name,
        uuid,
        host,
        port,
        security: params.get('security') || 'none',       // reality / tls / none
        network: params.get('type') || 'tcp',              // tcp / ws / grpc
        flow: params.get('flow') || '',                    // xtls-rprx-vision
        sni: params.get('sni') || '',
        fingerprint: params.get('fp') || 'chrome',
        publicKey: params.get('pbk') || '',                // reality publicKey
        shortId: params.get('sid') || '',                  // reality shortId
        // ws / grpc 参数
        wsPath: params.get('path') || '',
        wsHost: params.get('host') || '',
        grpcServiceName: params.get('serviceName') || ''
    };
}

/**
 * 按名称过滤节点（默认匹配美国相关关键词）
 * @param {object[]} nodes
 * @param {string} filter 正则字符串，空则不过滤
 */
function filterNodes(nodes, filter) {
    if (!filter) return nodes;
    const re = new RegExp(filter, 'i');
    return nodes.filter(n => re.test(n.name));
}

/**
 * 把 vless 节点转成 xray outbound 配置
 * @param {object} node
 */
function toXrayOutbound(node) {
    const outbound = {
        protocol: 'vless',
        tag: 'proxy',
        settings: {
            vnext: [{
                address: node.host,
                port: node.port,
                users: [{
                    id: node.uuid,
                    encryption: 'none',
                    ...(node.flow ? { flow: node.flow } : {})
                }]
            }]
        },
        streamSettings: {
            network: node.network,
            security: node.security
        }
    };

    if (node.security === 'reality') {
        outbound.streamSettings.realitySettings = {
            serverName: node.sni,
            fingerprint: node.fingerprint,
            publicKey: node.publicKey,
            ...(node.shortId ? { shortId: node.shortId } : {})
        };
    } else if (node.security === 'tls') {
        outbound.streamSettings.tlsSettings = {
            serverName: node.sni || node.host,
            fingerprint: node.fingerprint
        };
    }

    if (node.network === 'ws') {
        outbound.streamSettings.wsSettings = {
            path: node.wsPath || '/',
            ...(node.wsHost ? { headers: { Host: node.wsHost } } : {})
        };
    } else if (node.network === 'grpc') {
        outbound.streamSettings.grpcSettings = {
            serviceName: node.grpcServiceName
        };
    }

    return outbound;
}

/**
 * 一站式：订阅文本 -> 选中节点的 xray outbound
 * @param {string} raw 订阅原始文本
 * @param {string} filter 节点名称过滤正则
 * @returns {{outbound: object, nodeName: string, totalNodes: number, matchedNodes: string[]}}
 */
function pickOutbound(raw, filter) {
    const links = decodeSubscription(raw);
    const vlessLinks = links.filter(l => l.startsWith('vless://'));
    if (vlessLinks.length === 0) {
        throw new Error(`订阅中没有 vless:// 节点（共 ${links.length} 条链接）。目前只支持 VLESS 节点。`);
    }
    const nodes = vlessLinks.map(parseVless);
    const matched = filterNodes(nodes, filter);
    if (matched.length === 0) {
        const names = nodes.map(n => n.name).join(', ');
        throw new Error(`没有节点匹配过滤器 "${filter}"。可用节点: ${names}`);
    }
    const chosen = matched[0];
    return {
        outbound: toXrayOutbound(chosen),
        nodeName: chosen.name,
        totalNodes: nodes.length,
        matchedNodes: matched.map(n => n.name)
    };
}

/**
 * 列出订阅中所有可用节点（不去重，不做选择）
 * @param {string} raw 订阅原始文本
 * @returns {Array<{name, host, port, security, network, raw}>}
 */
function listNodes(raw) {
    const links = decodeSubscription(raw);
    const vlessLinks = links.filter(l => l.startsWith('vless://'));
    return vlessLinks.map(link => {
        const node = parseVless(link);
        return {
            name: node.name,
            host: node.host,
            port: node.port,
            security: node.security,
            network: node.network,
            raw: link
        };
    });
}

/**
 * 根据节点 name 从订阅中挑出对应的 outbound
 * @param {string} raw 订阅原始文本
 * @param {string} nodeName 节点名称（精确匹配）
 * @returns {{outbound: object, nodeName: string}}
 */
function pickOutboundByName(raw, nodeName) {
    const links = decodeSubscription(raw);
    const vlessLinks = links.filter(l => l.startsWith('vless://'));
    for (const link of vlessLinks) {
        const node = parseVless(link);
        if (node.name === nodeName) {
            return {
                outbound: toXrayOutbound(node),
                nodeName: node.name
            };
        }
    }
    throw new Error(`订阅中找不到节点 "${nodeName}"`);
}

module.exports = {
    decodeSubscription,
    parseVless,
    filterNodes,
    toXrayOutbound,
    pickOutbound,
    listNodes,
    pickOutboundByName
};
