/**
 * 用默认浏览器打开音色引擎面板。
 *
 * 端口每次 DSH 重启都会变，所以从 voice-mini 写的 runtime.json 里取 origin。
 * 用法：node open-panel.mjs
 */
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const runtimePath = process.env.DSH_VOICE_MINI_RUNTIME
    ?? join(homedir(), '.dsh', 'voice-mini', 'runtime.json');

let origin = '';
try {
    origin = String(JSON.parse(readFileSync(runtimePath, 'utf8')).origin ?? '');
}
catch (error) {
    console.error(`读不到 ${runtimePath}：${error.message}`);
    process.exit(1);
}

if (!origin) {
    console.error(`${runtimePath} 里没有 origin，DSH 可能还没启动过。`);
    process.exit(1);
}

const base = origin.replace(/\/+$/, '');
const stateUrl = `${base}/voice-engine/state`;

let reachable = false;
try {
    const res = await fetch(stateUrl, { signal: AbortSignal.timeout(5000) });
    reachable = res.ok;
}
catch {
    reachable = false;
}

if (!reachable) {
    console.error(`插件的路由没响应：${stateUrl}`);
    console.error('说明当前这个 DSH 进程还没加载带 /panel 的版本，重启 DSH 后再试。');
    process.exit(2);
}

const url = `${base}/voice-engine/panel`;
const opener = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

exec(opener, (error) => {
    if (error) {
        console.error(`打开浏览器失败：${error.message}`);
        console.log(url);
        return;
    }
    console.log(url);
});
