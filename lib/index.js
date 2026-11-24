/**
 * dsh-voice-engine — 本地音色引擎插件。
 *
 * 它做四件事：
 *   1. 拥有 F5-TTS 常驻服务（启动、健康检查、按需拉起）；
 *   2. 拥有音色库（voices.json：参考音频 + 逐字稿 + 推理参数）；
 *   3. 试听（/preview 合成到缓存目录，前端直接播）；
 *   4. 把本地音色推到 dsh-duet 云端，并写回 duet 的 links.json。
 *
 * 与 dsh-voice-mini 的关系：voice-mini 的 clone 后端打的就是同一个
 * http://127.0.0.1:<port> 服务，音色键也来自同一份 voices.json。
 * 所以本插件不需要改 voice-mini 的代码，两者天然共用一套音色。
 */
import z from '@deepseek-ai/schemastery';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const name = 'dsh-voice-engine';

/** 没有硬依赖：webServer 可能在 apply 之后才就绪，用 ctx.inject 等它。 */
export const inject = [];

export const Config = z.object({
    /** 引擎根目录：含 .venv、tools/f5_server.py、voices.json、refs/。 */
    engineRoot: z.string().default('~/voice-engine'),
    /** 覆盖解释器路径；空 = <engineRoot>/.venv/{Scripts/python.exe | bin/python}。 */
    python: z.string().default(''),
    /** F5 HTTP 服务端口。 */
    port: z.number().default(18231),
    /** 插件加载时若服务不在线，就拉起来。 */
    autoStart: z.boolean().default(true),
    /** 试听音频缓存目录。 */
    audioCache: z.string().default('~/.dsh/voice-engine/audio'),
    /** 拉起服务时等健康检查通过的上限（毫秒）。冷启动含模型加载约 30–60 s。 */
    bootTimeoutMs: z.number().default(120000),
    /** synth 单句超时。 */
    synthTimeoutMs: z.number().default(300000),
    /** dsh-duet 数据目录（读 links.json / 写回上传结果）。 */
    duetDir: z.string().default('~/.dsh/dsh-duet'),
    /** 云端音色上传端点。 */
    duetUploadUrl: z.string().default(''),
    /** 上传用的 Authorization 头；空则「推送到 duet」直接返回 400。 */
    duetAuthorization: z.string().default(''),
    /** 面板里「用这个音色」时同步改 voice-mini 的配置。 */
    syncVoiceMini: z.boolean().default(true),
});

const IS_WIN = process.platform === 'win32';
const DETACHED = 0x00000008 | 0x00000200; // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

/** Config 的默认值；rawConfig 逐键覆盖。 */
const DEFAULTS = {
    engineRoot: '~/voice-engine',
    python: '',
    port: 18231,
    autoStart: true,
    audioCache: '~/.dsh/voice-engine/audio',
    bootTimeoutMs: 120000,
    synthTimeoutMs: 300000,
    duetDir: '~/.dsh/dsh-duet',
    duetUploadUrl: '',
    duetAuthorization: '',
    syncVoiceMini: true,
};

// ── paths ────────────────────────────────────────────────────────────────────

function expandHome(p) {
    if (!p)
        return p;
    if (p === '~')
        return homedir();
    if (p.startsWith('~/') || p.startsWith('~\\'))
        return join(homedir(), p.slice(2));
    return p;
}

function paths(config) {
    const root = resolve(expandHome(config.engineRoot));
    // pythonw.exe is the windowed interpreter: it never attaches or creates a
    // console, so autostart cannot flash a terminal window on Windows.
    const venvScripts = join(root, '.venv', 'Scripts');
    const guiPython = join(venvScripts, 'pythonw.exe');
    const python = config.python
        ? resolve(expandHome(config.python))
        : IS_WIN
            ? (existsSync(guiPython) ? guiPython : join(venvScripts, 'python.exe'))
            : join(root, '.venv', 'bin', 'python');
    return {
        root,
        python,
        script: join(root, 'tools', 'f5_server.py'),
        voices: join(root, 'voices.json'),
        log: join(root, 'work', 'f5_console.log'),
        cache: resolve(expandHome(config.audioCache)),
        base: `http://127.0.0.1:${config.port}`,
    };
}

// ── http helpers ─────────────────────────────────────────────────────────────

function sendJson(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

// Plain-DOM panel. Rendered by the host so it keeps working even when the
// session header slot is unavailable.
const PANEL_HTML = [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>音色引擎</title><style>',
    ':root{color-scheme:dark}',
    '*{box-sizing:border-box}',
    'body{margin:0;font:13px/1.55 ui-sans-serif,system-ui,"Segoe UI",sans-serif;background:#18181b;color:#e4e4e7}',
    'header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2a30}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#3f3f46}',
    '.dot.on{background:#4ade80}',
    'main{padding:10px 12px 20px}',
    'h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b8b96;margin:16px 0 6px;font-weight:600}',
    '.row{display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #22222a}',
    '.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.key{color:#6b6b76;font-size:11px}',
    'button{font:inherit;font-size:12px;padding:3px 9px;border-radius:6px;border:1px solid #3a3a44;background:#232329;color:#e4e4e7;cursor:pointer}',
    'button:hover{background:#2e2e36}',
    'button[disabled]{opacity:.45;cursor:default}',
    'textarea{width:100%;height:56px;resize:vertical;background:#232329;color:#e4e4e7;border:1px solid #3a3a44;border-radius:6px;padding:6px 8px;font:inherit}',
    'select{background:#232329;color:#e4e4e7;border:1px solid #3a3a44;border-radius:6px;padding:3px 6px;font:inherit}',
    '.bar{display:flex;gap:6px;align-items:center;margin-top:6px}',
    '.msg{color:#8b8b96;font-size:12px;min-height:18px;margin-top:8px}',
    '</style></head><body>',
    '<header><span class="dot" id="dot"></span><strong id="st">检测中…</strong><span style="flex:1"></span>',
    '<button id="refresh">刷新</button></header>',
    '<main><h2>本地音色</h2><div id="voices"></div>',
    '<h2>试听</h2><textarea id="txt">这是本地音色引擎的试听。</textarea>',
    '<div class="bar"><select id="sel"></select><button id="play">合成并播放</button></div>',
    '<h2>duet 云端</h2><div id="duet"></div>',
    '<div class="msg" id="msg"></div></main>',
    '<script>',
    'const API="/voice-engine";',
    'const $=id=>document.getElementById(id);',
    'const post=(p,b)=>fetch(API+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})}).then(r=>r.json());',
    'function msg(t){$("msg").textContent=t||""}',
    'function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}',
    'function btn(label,fn){const b=el("button",null,label);b.onclick=()=>{b.disabled=true;Promise.resolve().then(fn).catch(e=>msg(String(e&&e.message||e))).finally(()=>{b.disabled=false})};return b}',
    'let state=null;',
    'function render(){',
    ' const on=!!(state&&state.running);',
    ' $("dot").className="dot"+(on?" on":"");',
    ' $("st").textContent=state?("引擎"+(on?"在线":"离线")+" · "+state.port+(state.health&&state.health.device?" · "+state.health.device:"")):"检测中…";',
    ' const vs=(state&&state.voices)||[];',
    ' const box=$("voices");box.textContent="";',
    ' const sel=$("sel");sel.textContent="";',
    ' vs.forEach(v=>{',
    '  const r=el("div","row");',
    '  const n=el("div","nm");n.appendChild(el("div",null,v.name));n.appendChild(el("div","key",v.key));',
    '  r.appendChild(n);',
    '  r.appendChild(btn("试听",()=>post("/preview",{text:$("txt").value||"试听",voice:v.key}).then(o=>{if(o.ok){new Audio(o.url).play();msg("合成 "+o.ms+" ms / "+o.bytes+" B")}else msg(o.error||"合成失败")})));',
    '  r.appendChild(btn("用这个",()=>post("/activate",{key:v.key}).then(o=>msg(o.ok?"已设为 voice-mini 音色："+v.key:(o.error||"失败")))));',
    '  if(state&&state.duetConfigured)r.appendChild(btn("→duet",()=>{if(!confirm("把 "+v.name+" 上传到 duet 云端？"))return;msg("上传中…");return post("/duet/push",{key:v.key}).then(o=>msg(o.ok?"已推送："+(o.voiceId||""):(o.error||"失败"))) }));',
    '  box.appendChild(r);',
    '  const opt=el("option",null,v.name);opt.value=v.key;sel.appendChild(opt);',
    ' });',
    ' if(!vs.length)box.appendChild(el("div","key","没有音色"));',
    ' const d=(state&&state.duet&&state.duet.voices)||[];',
    ' const db=$("duet");db.textContent="";',
    ' d.forEach(v=>{const r=el("div","row");const n=el("div","nm");n.appendChild(el("div",null,v.name));n.appendChild(el("div","key",v.status+" · "+String(v.voiceId).slice(0,18)));r.appendChild(n);if(state.duet.selected===v.voiceId)r.appendChild(el("span","key","当前"));db.appendChild(r)});',
    ' if(!d.length)db.appendChild(el("div","key",state&&state.duetConfigured?"没有云端音色":"未配置上传凭证"));',
    '}',
    'function load(){return fetch(API+"/state").then(r=>r.json()).then(s=>{state=s;render()}).catch(e=>msg("读取失败："+e))}',
    '$("refresh").onclick=()=>load();',
    '$("play").onclick=()=>{const v=$("sel").value;if(!v)return msg("没有可选音色");msg("合成中…");post("/preview",{text:$("txt").value,voice:v}).then(o=>{if(o.ok){new Audio(o.url).play();msg("合成 "+o.ms+" ms / "+o.bytes+" B")}else msg(o.error||"合成失败")})};',
    'load();setInterval(load,15000);',
    '</'+'script></body></html>',
].join('\n');

async function readBody(req) {
    let data = '';
    for await (const chunk of req)
        data += chunk;
    return data;
}

async function readJsonBody(req, limit = 1 << 20) {
    const raw = await readBody(req);
    if (raw.length > limit)
        throw new Error('body too large');
    if (!raw.trim())
        return {};
    return JSON.parse(raw);
}

async function fetchJson(url, init, timeoutMs = 5000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: ac.signal });
        const text = await res.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        }
        catch {
            body = { raw: text };
        }
        return { status: res.status, body };
    }
    finally {
        clearTimeout(timer);
    }
}

/** /health：服务在线就返回它的报告，否则 null。 */
async function probe(base) {
    try {
        const { status, body } = await fetchJson(`${base}/health`, { method: 'GET' }, 1500);
        if (status === 200 && body && body.ok)
            return body;
    }
    catch {
        /* not listening */
    }
    return null;
}

// ── engine lifecycle ────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootEngine(config) {
    const p = paths(config);
    if (!existsSync(p.python))
        throw new Error(`engine: python not found at ${p.python}`);
    if (!existsSync(p.script))
        throw new Error(`engine: service script not found at ${p.script}`);
    mkdirSync(dirname(p.log), { recursive: true });
    const out = existsSync(p.log) ? 'a' : 'w';
    const fd = openSync(p.log, out);
    const child = spawn(p.python, [p.script, '--port', String(config.port)], {
        cwd: p.root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        ...(IS_WIN ? { creationflags: DETACHED } : {}),
    });
    child.unref();
    const started = Date.now();
    while (Date.now() - started < config.bootTimeoutMs) {
        await sleep(600);
        const health = await probe(p.base);
        if (health)
            return { health, ms: Date.now() - started, pid: child.pid ?? null };
    }
    throw new Error(`engine: service did not answer /health within ${config.bootTimeoutMs} ms (log: ${p.log})`);
}

/** 单飞：并发调用共享同一次启动。 */
let booting = null;

async function ensureEngine(ctx, config) {
    const p = paths(config);
    const health = await probe(p.base);
    if (health)
        return { running: true, health, booted: false, ms: 0, pid: null };
    if (!booting) {
        booting = bootEngine(config)
            .then((r) => ({ running: true, health: r.health, booted: true, ms: r.ms, pid: r.pid }))
            .finally(() => {
                booting = null;
            });
        ctx.logger.info(`dsh-voice-engine: starting service on ${p.base}`);
    }
    return booting;
}

// ── voice library ───────────────────────────────────────────────────────────

function readVoicesRaw(file) {
    if (!existsSync(file))
        return {};
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        throw new Error(`voices.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function writeVoicesRaw(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
}

function relRef(root, ref) {
    if (!ref)
        return '';
    if (!isAbsolute(ref))
        return ref.replace(/\\/g, '/');
    const r = resolve(ref);
    const prefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}${IS_WIN ? '\\' : '/'}`;
    return r.startsWith(prefix) ? r.slice(prefix.length).replace(/\\/g, '/') : r.replace(/\\/g, '/');
}

function listVoices(config) {
    const p = paths(config);
    const raw = readVoicesRaw(p.voices);
    return Object.entries(raw).map(([key, v]) => ({
        key,
        name: v.name ?? key,
        ref: v.ref ?? '',
        refText: v.ref_text ?? '',
        speed: Number(v.speed ?? 1),
        nfe: Number(v.nfe ?? 32),
        cfg: Number(v.cfg ?? 2),
        refExists: v.ref ? existsSync(isAbsolute(v.ref) ? v.ref : join(p.root, v.ref)) : false,
    }));
}

// ── synthesis ───────────────────────────────────────────────────────────────

async function synthesize(config, { text, voice, speed, nfe, cfg }) {
    const p = paths(config);
    const body = { text: String(text ?? '').trim(), voice };
    if (speed !== undefined)
        body.speed = Number(speed);
    if (nfe !== undefined)
        body.nfe = Number(nfe);
    if (cfg !== undefined)
        body.cfg = Number(cfg);
    if (!body.text)
        throw new Error('text is empty');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.synthTimeoutMs);
    try {
        const res = await fetch(`${p.base}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(body),
            signal: ac.signal,
        });
        if (!res.ok) {
            const detail = await res.text();
            throw new Error(`engine /tts ${res.status}: ${detail.slice(0, 300)}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200)
            throw new Error(`engine /tts returned ${buf.length} bytes`);
        return {
            buffer: buf,
            sr: Number(res.headers.get('x-tts-sr') ?? 24000),
            ms: Number(res.headers.get('x-tts-ms') ?? 0),
            voice: res.headers.get('x-tts-voice') ?? String(voice ?? ''),
        };
    }
    finally {
        clearTimeout(timer);
    }
}

// ── duet bridge ─────────────────────────────────────────────────────────────

function duetLinksPath(config) {
    return join(resolve(expandHome(config.duetDir)), 'voices', 'links.json');
}

function readDuetLinks(config) {
    const file = duetLinksPath(config);
    if (!existsSync(file))
        return { file, selected: null, voices: [] };
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return {
            file,
            selected: raw.selected ?? null,
            voices: (raw.voices ?? []).map((v) => ({
                voiceId: v.voice_id,
                name: v.name,
                status: v.status,
                refText: v.ref_text ?? '',
                duration: v.duration ?? null,
            })),
        };
    }
    catch {
        return { file, selected: null, voices: [] };
    }
}

function ffmpegToMp3(input, output) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ac', '1', '-ar', '24000', '-b:a', '96k', output], {
            windowsHide: true,
        });
        let err = '';
        child.stderr?.on('data', (d) => {
            err += String(d);
        });
        child.on('error', (e) => rejectPromise(new Error(`ffmpeg: ${e.message}`)));
        child.on('close', (code) => {
            if (code === 0 && existsSync(output))
                resolvePromise();
            else
                rejectPromise(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`));
        });
    });
}

async function pushToDuet(config, key) {
    const p = paths(config);
    if (!config.duetUploadUrl)
        throw new Error('duetUploadUrl is empty');
    if (!config.duetAuthorization)
        throw new Error('duetAuthorization is empty');
    const raw = readVoicesRaw(p.voices);
    const entry = raw[key];
    if (!entry)
        throw new Error(`voice "${key}" not in voices.json`);
    const refAbs = isAbsolute(entry.ref) ? entry.ref : join(p.root, entry.ref);
    if (!existsSync(refAbs))
        throw new Error(`reference audio missing: ${refAbs}`);

    const workDir = join(p.root, 'work');
    mkdirSync(workDir, { recursive: true });
    const mp3 = join(workDir, `duet_${key}_${Date.now()}.mp3`);
    await ffmpegToMp3(refAbs, mp3);
    const audio = readFileSync(mp3);
    if (audio.length > 10 * 1024 * 1024)
        throw new Error(`encoded reference is ${audio.length} bytes, over the 10 MB upload cap`);

    const uploadId = randomUUID();
    const res = await fetch(config.duetUploadUrl, {
        method: 'POST',
        headers: {
            authorization: config.duetAuthorization,
            'x-upload-id': uploadId,
            'content-type': 'application/octet-stream',
        },
        body: audio,
    });
    const text = await res.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    }
    catch {
        parsed = { raw: text };
    }
    if (!res.ok || !parsed?.voice_id)
        throw new Error(`duet upload failed (${res.status}): ${text.slice(0, 300)}`);

    const voiceId = parsed.voice_id;
    // 云端异步转码，轮询到 ready 再落盘，避免 links.json 里留下 queued 条目。
    let info = null;
    for (let i = 0; i < 20; i++) {
        await sleep(1200);
        try {
            const r = await fetchJson(`${config.duetUploadUrl.replace(/\/voices\/upload$/, '')}/voices/info`, {
                method: 'POST',
                headers: { authorization: config.duetAuthorization, 'content-type': 'application/json' },
                body: JSON.stringify({ voice_id: voiceId }),
            }, 8000);
            info = r.body;
            if (info?.status === 'ready')
                break;
        }
        catch {
            /* keep polling */
        }
    }

    const linksFile = duetLinksPath(config);
    const links = existsSync(linksFile) ? JSON.parse(readFileSync(linksFile, 'utf8')) : { selected: null, voices: [] };
    const voicesDir = dirname(linksFile);
    const name = entry.name ?? key;
    const record = {
        voice_id: voiceId,
        name,
        file: `${audio.length}.${Date.now()}.${voiceId.slice(-8)}.audio`,
        scope: links.voices?.[0]?.scope ?? '',
        ref_text: info?.ref_text ?? entry.ref_text ?? '',
        status: info?.status ?? 'queued',
    };
    writeFileSync(join(voicesDir, record.file), audio, { mode: 0o600 });
    links.voices = [record, ...(links.voices ?? []).filter((v) => v.voice_id !== voiceId)];
    links.selected = voiceId;
    writeFileSync(linksFile, `${JSON.stringify(links, null, 2)}\n`, 'utf8');

    return { voiceId, status: record.status, refText: record.ref_text, bytes: audio.length, name };
}

// ── activate for voice-mini ─────────────────────────────────────────────────

async function activateForVoiceMini(config, key, origin) {
    if (!config.syncVoiceMini)
        return { skipped: true };
    if (!origin)
        return { skipped: true, reason: 'origin unknown' };
    try {
        const { status, body } = await fetchJson(`${origin}/voice-mini/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ backend: 'clone', voiceMode: 'fixed', voice: key }),
        }, 6000);
        return { ok: status === 200, status, body };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// ── plugin ──────────────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    const p = paths(config);

    /** 面板/其他调用方拿到的服务快照。 */
    const snapshot = async () => {
        const health = await probe(p.base);
        return {
            running: health !== null,
            port: config.port,
            base: p.base,
            root: p.root,
            python: p.python,
            pythonExists: existsSync(p.python),
            scriptExists: existsSync(p.script),
            log: p.log,
            health,
            voices: listVoices(config),
            duet: readDuetLinks(config),
            duetConfigured: Boolean(config.duetUploadUrl && config.duetAuthorization),
        };
    };

    if (config.autoStart) {
        void (async () => {
            try {
                const r = await ensureEngine(ctx, config);
                ctx.logger.info(`dsh-voice-engine: service ${r.booted ? `booted in ${r.ms} ms` : 'already running'} on ${p.base}`);
            }
            catch (error) {
                ctx.logger.warn(`dsh-voice-engine: autostart failed — ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    }

    ctx.inject(['webServer'], (serverCtx) => {
        const webServer = serverCtx.get('webServer');
        if (webServer === undefined)
            return;
        const host = webServer.host && webServer.host !== '0.0.0.0' ? webServer.host : '127.0.0.1';
        const origin = `http://${host}:${String(webServer.port ?? '')}`;
        webServer.register({
            kind: 'prefix',
            path: '/voice-engine',
            handler: async (req, res) => {
                const pathname = (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')
                    ? (req.url ?? '').replace(/^\/voice-engine/, '').split('?')[0] || '/'
                    : '/';
                const method = req.method ?? 'GET';
                try {
                    if (pathname === '/state' && method === 'GET') {
                        return sendJson(res, 200, await snapshot());
                    }
                    if (pathname === '/health' && method === 'GET') {
                        const health = await probe(p.base);
                        return sendJson(res, 200, { ok: health !== null, health });
                    }
                    if (pathname === '/panel' && method === 'GET') {
                        res.writeHead(200, {
                            'content-type': 'text/html; charset=utf-8',
                            'cache-control': 'no-store',
                        });
                        res.end(PANEL_HTML);
                        return;
                    }
                    if (pathname === '/ping' && method === 'GET') {
                        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
                        const extra = (query.get('note') ?? '').slice(0, 600);
                        const row = `${new Date().toISOString()} hasSlots=${query.get('hasSlots') ?? '-'} registered=${query.get('registered') ?? '-'}${extra ? ` note=${extra}` : ''}`;
                        try {
                            mkdirSync(join(p.root, 'work'), { recursive: true });
                            appendFileSync(join(p.root, 'work', 'client-ping.log'), `${row}\n`, 'utf8');
                        }
                        catch {
                            // diagnostics only
                        }
                        return sendJson(res, 200, { ok: true });
                    }
                    if (pathname === '/start' && method === 'POST') {
                        const r = await ensureEngine(ctx, config);
                        return sendJson(res, 200, { ok: true, ...r, health: r.health ?? null });
                    }
                    if (pathname === '/voices' && method === 'GET') {
                        return sendJson(res, 200, { voices: listVoices(config) });
                    }
                    if (pathname === '/voices' && method === 'POST') {
                        const body = await readJsonBody(req);
                        const key = String(body.key ?? '').trim();
                        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key))
                            return sendJson(res, 400, { ok: false, error: 'key must match /^[A-Za-z0-9_-]{1,64}$/' });
                        const raw = readVoicesRaw(p.voices);
                        const prev = raw[key] ?? {};
                        raw[key] = {
                            name: String(body.name ?? prev.name ?? key),
                            ref: relRef(p.root, String(body.ref ?? prev.ref ?? '')),
                            ref_text: String(body.ref_text ?? body.refText ?? prev.ref_text ?? ''),
                            speed: Number(body.speed ?? prev.speed ?? 1),
                            nfe: Number(body.nfe ?? prev.nfe ?? 32),
                            cfg: Number(body.cfg ?? prev.cfg ?? 2),
                        };
                        writeVoicesRaw(p.voices, raw);
                        return sendJson(res, 200, { ok: true, key, voice: raw[key] });
                    }
                    if (pathname === '/voices/delete' && method === 'POST') {
                        const body = await readJsonBody(req);
                        const key = String(body.key ?? '').trim();
                        const raw = readVoicesRaw(p.voices);
                        if (!raw[key])
                            return sendJson(res, 404, { ok: false, error: `no such voice: ${key}` });
                        delete raw[key];
                        writeVoicesRaw(p.voices, raw);
                        return sendJson(res, 200, { ok: true, key });
                    }
                    if (pathname === '/preview' && method === 'POST') {
                        const body = await readJsonBody(req);
                        const out = await synthesize(config, {
                            text: body.text,
                            voice: body.voice,
                            speed: body.speed,
                            nfe: body.nfe,
                            cfg: body.cfg,
                        });
                        mkdirSync(p.cache, { recursive: true });
                        const file = `${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
                        writeFileSync(join(p.cache, file), out.buffer);
                        return sendJson(res, 200, { ok: true, url: `/voice-engine/audio/${file}`, ms: out.ms, bytes: out.buffer.length });
                    }
                    if (pathname.startsWith('/audio/') && method === 'GET') {
                        const file = pathname.slice('/audio/'.length);
                        if (!/^[\w.-]+$/.test(file))
                            return sendJson(res, 400, { ok: false, error: 'bad file name' });
                        const abs = join(p.cache, file);
                        if (!existsSync(abs))
                            return sendJson(res, 404, { ok: false, error: 'not found' });
                        const stat = statSync(abs);
                        res.writeHead(200, {
                            'content-type': 'audio/wav',
                            'content-length': String(stat.size),
                            'cache-control': 'no-store',
                        });
                        createReadStream(abs).pipe(res);
                        return;
                    }
                    if (pathname === '/activate' && method === 'POST') {
                        const body = await readJsonBody(req);
                        const key = String(body.key ?? '').trim();
                        const raw = readVoicesRaw(p.voices);
                        if (!raw[key])
                            return sendJson(res, 404, { ok: false, error: `no such voice: ${key}` });
                        const r = await activateForVoiceMini(config, key, origin);
                        return sendJson(res, 200, { ok: true, key, voiceMini: r });
                    }
                    if (pathname === '/duet' && method === 'GET') {
                        return sendJson(res, 200, { ...readDuetLinks(config), configured: Boolean(config.duetUploadUrl && config.duetAuthorization) });
                    }
                    if (pathname === '/duet/push' && method === 'POST') {
                        const body = await readJsonBody(req);
                        const r = await pushToDuet(config, String(body.key ?? '').trim());
                        return sendJson(res, 200, { ok: true, ...r });
                    }
                    return sendJson(res, 404, { ok: false, error: `unknown endpoint ${method} ${pathname}` });
                }
                catch (error) {
                    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            },
        });
        ctx.logger.info('dsh-voice-engine: routes mounted at /voice-engine');
    });
}
