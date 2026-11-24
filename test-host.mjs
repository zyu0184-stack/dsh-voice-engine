/**
 * 离线冒烟：不启动 DSH，直接把插件挂到一个裸 http server 上，逐个打路由。
 * 用法：node test-host.mjs
 */
import { createServer } from 'node:http';
import { apply } from './lib/index.js';

const PORT = 18999;
const routes = [];

const webServer = {
    host: '127.0.0.1',
    port: PORT,
    register(entry) {
        routes.push(entry);
    },
};

const ctx = {
    logger: {
        info: (...a) => console.log('[info]', ...a),
        warn: (...a) => console.warn('[warn]', ...a),
        debug: () => {},
    },
    inject(names, cb) {
        if (names.includes('webServer'))
            cb({ get: (n) => (n === 'webServer' ? webServer : undefined) });
    },
    get: () => undefined,
};

apply(ctx, {
    autoStart: false,
    engineRoot: process.env.VOICE_ENGINE_ROOT ?? '~/voice-engine',
    duetDir: process.env.DUET_DIR ?? '~/.dsh/dsh-duet',
});
console.log('routes:', routes.map((r) => `${r.kind} ${r.path}`).join(', '));

const prefix = routes[0];
const server = createServer((req, res) => void prefix.handler(req, res));
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const base = `http://127.0.0.1:${PORT}/voice-engine`;
const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('audio/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, audio: `${buf.length} bytes, ct=${ct}` };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
};

const show = (label, r) => console.log(`\n== ${label} ==`, JSON.stringify(r).slice(0, 900));

show('GET /state', await call('GET', '/state'));
show('GET /voices', await call('GET', '/voices'));
show('GET /duet', await call('GET', '/duet'));
show('POST /voices (bad key)', await call('POST', '/voices', { key: 'bad key!', ref: 'x.wav' }));
show('GET /nope', await call('GET', '/nope'));
show('GET /ping', await call('GET', '/ping?hasSlots=1&registered=1'));

{
    const res = await fetch(`${base}/panel`);
    const html = await res.text();
    console.log(`\n== GET /panel == status=${res.status} bytes=${Buffer.byteLength(html)} playBtn=${html.includes('合成并播放')} closes=${html.endsWith('</html>')}`);
}

const state = await call('GET', '/state');
if (state.body?.running) {
    show('POST /preview', await call('POST', '/preview', { text: '插件的试听通道已经通了。', voice: state.body.voices?.[0]?.key }));
}
else {
    console.log('\n引擎没在跑，跳过 /preview（先 POST /start）');
    show('POST /start', await call('POST', '/start'));
    show('POST /preview', await call('POST', '/preview', { text: '插件的试听通道已经通了。', voice: state.body?.voices?.[0]?.key }));
}

server.close();
console.log('\ndone');
