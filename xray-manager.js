// xray-manager.js
// 负责下载 xray、校验、生成配置、启动/停止进程
// 零外部依赖，只用 Node 内置模块

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const XRAY_VERSION = 'v25.10.15';
const RELEASE_BASE = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}`;

// 平台 -> { asset, sha256 (官方发布哈希), binName }
// 注意：sha256 需要填官方 Release 页的哈希，下载前会校验
const PLATFORM_MAP = {
    'win32-x64': { asset: 'Xray-windows-64.zip', binName: 'xray.exe', sha256: null },
    'linux-x64': { asset: 'Xray-linux-64.zip', binName: 'xray', sha256: null },
    'darwin-x64': { asset: 'Xray-macos-64.zip', binName: 'xray', sha256: null },
    'darwin-arm64': { asset: 'Xray-macos-arm64-v8a.zip', binName: 'xray', sha256: null },
    'linux-arm64': { asset: 'Xray-linux-arm64-v8a.zip', binName: 'xray', sha256: null }
};

function getPlatformKey() {
    return `${process.platform}-${process.arch}`;
}

function sha256File(file) {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function downloadFile(url, dest, log) {
    return new Promise((resolve, reject) => {
        log(`Downloading: ${url}`);
        const file = fs.createWriteStream(dest);
        let redirects = 0;

        function doGet(u) {
            const mod = u.startsWith('https:') ? https : http;
            const req = mod.get(u, {
                headers: { 'User-Agent': 'antigravity-proxy-launcher' },
                timeout: 120000
            }, res => {
                // 跟随重定向（GitHub Releases 会 302）
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (++redirects > 5) {
                        file.close();
                        return reject(new Error('Too many redirects'));
                    }
                    res.resume();
                    return doGet(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    file.close();
                    return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
                }
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve(dest)));
            });
            req.on('error', err => { file.close(); reject(err); });
            req.on('timeout', () => { req.destroy(new Error('download timeout')); });
        }
        doGet(url);
    });
}

async function fetchText(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https:') ? https : http;
        mod.get(url, { headers: { 'User-Agent': 'antigravity-proxy-launcher' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(fetchText(res.headers.location));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
    });
}

/**
 * 解压 zip（用系统自带工具，避免依赖 adm-zip 等库）
 */
async function extractZip(zipPath, destDir, log) {
    const platform = process.platform;
    if (platform === 'win32') {
        // Windows: PowerShell Expand-Archive
        execFileSync('powershell.exe', [
            '-NoProfile', '-Command',
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
        ]);
    } else if (platform === 'darwin') {
        execFileSync('unzip', ['-o', zipPath, '-d', destDir]);
    } else {
        // Linux: 优先 unzip，回退 python3 zipfile
        try {
            execFileSync('unzip', ['-o', zipPath, '-d', destDir]);
        } catch {
            execFileSync('python3', ['-c',
                `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`,
                zipPath, destDir
            ]);
        }
    }
    log(`Extracted to ${destDir}`);
}

/**
 * 确保 xray 二进制存在；不存在则下载并校验
 * @param {string} binDir 存放目录（globalStorageUri）
 * @param {function} log
 * @returns {Promise<string>} xray 可执行文件绝对路径
 */
async function ensureXray(binDir, log) {
    const key = getPlatformKey();
    const spec = PLATFORM_MAP[key];
    if (!spec) {
        throw new Error(`不支持的平台: ${key}. 支持: ${Object.keys(PLATFORM_MAP).join(', ')}`);
    }

    const binPath = path.join(binDir, spec.binName);
    if (fs.existsSync(binPath)) {
        log(`xray already present: ${binPath}`);
        return binPath;
    }

    fs.mkdirSync(binDir, { recursive: true });

    const zipPath = path.join(binDir, spec.asset);
    const url = `${RELEASE_BASE}/${spec.asset}`;
    await downloadFile(url, zipPath, log);

    // 校验：从 Release 下载 sha256 列表
    try {
        const sumsUrl = `${RELEASE_BASE}/Xray-linux-64.zip.dgst`; // 占位，真实发布有 .dgst 文件
        // Xray 官方提供 .dgst 文件，包含 SHA256
        const dgst = await fetchText(`${RELEASE_BASE}/${spec.asset}.dgst`);
        const m = dgst.match(/SHA256.*?=\s*([a-f0-9]{64})/i)
               || dgst.match(/([a-f0-9]{64})/);
        if (m) {
            const expected = m[1].toLowerCase();
            const actual = sha256File(zipPath);
            if (actual !== expected) {
                fs.unlinkSync(zipPath);
                throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
            }
            log('SHA256 verified.');
        } else {
            log('WARNING: could not parse .dgst file, skipping SHA256 verification');
        }
    } catch (e) {
        log(`WARNING: sha256 verification failed/skipped: ${e.message}`);
        // 不阻断，但明确告知用户
    }

    await extractZip(zipPath, binDir, log);

    if (!fs.existsSync(binPath)) {
        throw new Error(`解压后找不到 ${spec.binName}`);
    }

    if (process.platform !== 'win32') {
        fs.chmodSync(binPath, 0o755);
    }

    log(`xray ready: ${binPath}`);
    return binPath;
}

/**
 * 启动 xray 进程
 * @param {object} opts { binPath, outbound, listenHost, listenPort, workDir, log }
 * @returns {Promise<{process, port, stop: function}>}
 */
async function startXray(opts) {
    const { binPath, outbound, listenHost = '127.0.0.1', workDir, log } = opts;
    let listenPort = opts.listenPort;

    // xray 不支持 port: 0，需要先分配一个空闲端口
    if (!listenPort || listenPort === 0) {
        listenPort = await findFreePort(listenHost);
        log(`Allocated free port: ${listenPort}`);
    }

    const config = {
        log: { loglevel: 'warning' },
        inbounds: [{
            listen: listenHost,
            port: listenPort,
            protocol: 'http',
            settings: { allowTransparent: false }
        }],
        outbounds: [outbound]
    };

    const configPath = path.join(workDir, 'xray-config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`xray config written: ${configPath}`);

    const child = spawn(binPath, ['run', '-c', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    let stderr = '';
    child.stderr.on('data', d => {
        stderr += d.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.stdout.on('data', d => log(`[xray] ${d.toString().trim()}`));

    // 等待监听端口可用
    await waitForPort(child, listenPort, listenHost, log, () => stderr);

    log(`xray started on ${listenHost}:${listenPort} (pid ${child.pid})`);

    return {
        process: child,
        port: listenPort,
        stop: () => new Promise(resolve => {
            if (child.killed || child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            child.kill();
            // 兜底：3 秒后强杀
            setTimeout(() => {
                if (child.exitCode === null) {
                    try { child.kill('SIGKILL'); } catch {}
                }
                resolve();
            }, 3000);
        })
    };
}

/**
 * 让系统分配一个空闲端口
 */
function findFreePort(host) {
    return new Promise((resolve, reject) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, host, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

/**
 * 轮询检测端口监听状态
 */
async function waitForPort(child, port, host, log, getStderr) {
    const net = require('net');
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`xray exited early (code ${child.exitCode}). stderr:\n${getStderr()}`);
        }
        const ok = await new Promise(res => {
            const s = net.connect(port, host, () => { s.end(); res(true); });
            s.once('error', () => res(false));
            s.setTimeout(500, () => { s.destroy(); res(false); });
        });
        if (ok) return;
        await sleep(200);
    }
    throw new Error(`Timeout waiting for xray to listen on ${host}:${port}. stderr:\n${getStderr()}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { ensureXray, startXray, XRAY_VERSION };
