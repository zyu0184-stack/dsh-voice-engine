/**
 * dsh-voice-engine — 客户端面板。
 *
 * 只做一件事：把本地音色引擎的状态和操作放进会话头部按钮里。
 * 所有数据走 host 的 /voice-engine/* 路由，同源 fetch。
 */
window.__ModuleLoader__.load({
    id: 'dsh-voice-engine',
    factory: (require) => {
        const module = { exports: {} };
        const React = require('react');
        const { jsx, jsxs } = require('react/jsx-runtime');

        const API = '/voice-engine';
        const S = {
            panel: {
                position: 'fixed',
                top: 56,
                right: 16,
                width: 380,
                maxHeight: '70vh',
                overflow: 'auto',
                zIndex: 9999,
                borderRadius: 12,
                border: '1px solid rgba(128,128,128,.35)',
                background: 'rgba(24,24,27,.97)',
                color: '#e8e8ea',
                boxShadow: '0 10px 34px rgba(0,0,0,.45)',
                font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
                padding: 14,
            },
            row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' },
            grow: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            btn: {
                border: '1px solid rgba(128,128,128,.4)',
                background: 'transparent',
                color: 'inherit',
                borderRadius: 7,
                padding: '2px 8px',
                fontSize: 12,
                cursor: 'pointer',
                lineHeight: '20px',
            },
            dot: (on) => ({
                width: 8,
                height: 8,
                borderRadius: 4,
                background: on ? '#3ecf8e' : '#8a8a92',
                display: 'inline-block',
                marginRight: 6,
            }),
            muted: { opacity: 0.55, fontSize: 12 },
            input: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 8px',
                borderRadius: 7,
                border: '1px solid rgba(128,128,128,.4)',
                background: 'rgba(255,255,255,.04)',
                color: 'inherit',
                font: 'inherit',
                resize: 'vertical',
                minHeight: 54,
            },
            section: { marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(128,128,128,.22)' },
        };

        const get = async (path) => {
            const res = await fetch(`${API}${path}`);
            return res.json();
        };
        const post = async (path, body) => {
            const res = await fetch(`${API}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            return res.json();
        };

        function Panel({ onClose }) {
            const [state, setState] = React.useState(null);
            const [busy, setBusy] = React.useState('');
            const [note, setNote] = React.useState('');
            const [text, setText] = React.useState('这一段是用本地引擎合成出来的，听一下像不像。');
            const [voice, setVoice] = React.useState('');

            const refresh = React.useCallback(async () => {
                try {
                    const s = await get('/state');
                    setState(s);
                    setVoice((v) => v || s?.voices?.[0]?.key || '');
                }
                catch (error) {
                    setNote(`读取状态失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }, []);

            React.useEffect(() => {
                void refresh();
            }, [refresh]);

            const run = async (label, fn) => {
                setBusy(label);
                setNote('');
                try {
                    const r = await fn();
                    if (r && r.ok === false)
                        setNote(`${label}失败：${r.error ?? '未知错误'}`);
                    else
                        setNote(`${label}完成`);
                    await refresh();
                    return r;
                }
                catch (error) {
                    setNote(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
                }
                finally {
                    setBusy('');
                }
            };

            const preview = (voiceKey) => run('试听', async () => {
                const r = await post('/preview', { text: text || '试听', voice: voiceKey });
                if (r?.url)
                    new Audio(r.url).play();
                return r;
            });

            const voices = state?.voices ?? [];
            const duet = state?.duet ?? { voices: [], configured: false };
            const running = Boolean(state?.running);

            return jsxs('div', {
                style: S.panel,
                children: [
                    jsxs('div', {
                        style: { ...S.row, justifyContent: 'space-between' },
                        children: [
                            jsxs('div', {
                                style: { display: 'flex', alignItems: 'center', fontWeight: 600 },
                                children: [
                                    jsx('span', { style: S.dot(running) }),
                                    jsx('span', { children: running ? `引擎在线 · ${state.port}` : '引擎离线' }),
                                ],
                            }),
                            jsxs('div', {
                                style: { display: 'flex', gap: 6 },
                                children: [
                                    jsx('button', { style: S.btn, onClick: () => void refresh(), children: '刷新' }),
                                    jsx('button', { style: S.btn, onClick: onClose, children: '关闭' }),
                                ],
                            }),
                        ],
                    }),
                    running
                        ? jsx('div', {
                            style: S.muted,
                            children: `${state.health?.device ?? '?'} · 已合成 ${state.health?.calls ?? 0} 句 · ${voices.length} 个音色`,
                        })
                        : jsx('div', {
                            style: { marginTop: 8 },
                            children: jsx('button', {
                                style: S.btn,
                                onClick: () => void run('启动引擎', () => post('/start')),
                                children: busy === '启动引擎' ? '启动中…' : '启动引擎（首次约 30 秒）',
                            }),
                        }),

                    jsx('div', {
                        style: S.section,
                        children: [
                            jsx('div', { style: { fontWeight: 600, marginBottom: 4 }, children: '音色' }),
                            ...voices.map((v) => jsx('div', {
                                key: v.key,
                                style: S.row,
                                children: [
                                    jsx('span', {
                                        style: { ...S.grow, opacity: v.refExists ? 1 : 0.45 },
                                        title: `${v.key} · ${v.ref}`,
                                        children: v.name,
                                    }),
                                    jsx('button', {
                                        style: S.btn,
                                        onClick: () => void preview(v.key),
                                        children: busy === '试听' ? '…' : '▶',
                                    }),
                                    jsx('button', {
                                        style: S.btn,
                                        onClick: () => void run(`启用 ${v.name}`, () => post('/activate', { key: v.key })),
                                        children: voice === v.key ? '当前' : '用这个',
                                    }),
                                    jsx('button', {
                                        style: S.btn,
                                        onClick: () => void run(`推送 ${v.name}`, () => post('/duet/push', { key: v.key })),
                                        children: '→duet',
                                    }),
                                ],
                            })),
                        ],
                    }),

                    jsx('div', {
                        style: S.section,
                        children: [
                            jsx('div', { style: { fontWeight: 600, marginBottom: 6 }, children: '试听文本' }),
                            jsx('textarea', {
                                style: S.input,
                                value: text,
                                onChange: (e) => setText(e.target.value),
                            }),
                            jsxs('div', {
                                style: { ...S.row, marginTop: 6 },
                                children: [
                                    jsx('select', {
                                        style: { ...S.btn, flex: 1 },
                                        value: voice,
                                        onChange: (e) => setVoice(e.target.value),
                                        children: voices.map((v) => jsx('option', { key: v.key, value: v.key, children: v.name })),
                                    }),
                                    jsx('button', {
                                        style: S.btn,
                                        onClick: () => void preview(voice),
                                        children: busy === '试听' ? '合成中…' : '合成并播放',
                                    }),
                                ],
                            }),
                        ],
                    }),

                    jsx('div', {
                        style: S.section,
                        children: [
                            jsx('div', { style: { fontWeight: 600, marginBottom: 4 }, children: 'duet 云端音色' }),
                            duet.configured
                                ? null
                                : jsx('div', { style: S.muted, children: '未配置上传凭证，推送到 duet 会返回 400' }),
                            ...(duet.voices ?? []).map((v) => jsx('div', {
                                key: v.voiceId,
                                style: S.row,
                                children: [
                                    jsx('span', { style: S.grow, children: v.name }),
                                    jsx('span', { style: S.muted, children: v.status }),
                                ],
                            })),
                        ],
                    }),

                    note ? jsx('div', { style: { ...S.muted, marginTop: 10 }, children: note }) : null,
                    jsx('div', {
                        style: { ...S.muted, marginTop: 10, wordBreak: 'break-all' },
                        children: state?.root ?? '',
                    }),
                ],
            });
        }

        function EngineButton() {
            return jsx('button', {
                title: '本地音色引擎',
                onClick: () => showOverlay(),
                style: {
                    border: '1px solid rgba(128,128,128,.35)',
                    background: 'transparent',
                    color: 'inherit',
                    borderRadius: 7,
                    padding: '2px 8px',
                    fontSize: 12,
                    cursor: 'pointer',
                    lineHeight: '20px',
                },
                children: '音色引擎',
            });
        }

        const OVERLAY_ID = 'voice-engine-overlay';

        function ensureOverlay() {
            let holder = document.getElementById(OVERLAY_ID);
            if (holder)
                return holder;
            holder = document.createElement('div');
            holder.id = OVERLAY_ID;
            Object.assign(holder.style, {
                position: 'fixed', inset: '0', zIndex: '2147483000',
                display: 'none', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,.55)',
            });
            const frame = document.createElement('iframe');
            frame.src = '/voice-engine/panel';
            frame.setAttribute('title', '音色引擎');
            Object.assign(frame.style, {
                width: 'min(520px, 92vw)', height: 'min(760px, 88vh)',
                border: '1px solid rgba(128,128,128,.35)', borderRadius: '12px',
                background: '#18181b', boxShadow: '0 24px 80px rgba(0,0,0,.6)',
            });
            holder.appendChild(frame);
            holder.addEventListener('click', (ev) => {
                if (ev.target === holder)
                    hideOverlay();
            });
            document.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape')
                    hideOverlay();
            });
            document.body.appendChild(holder);
            return holder;
        }

        function showOverlay() {
            ensureOverlay().style.display = 'flex';
        }

        function hideOverlay() {
            const holder = document.getElementById(OVERLAY_ID);
            if (holder)
                holder.style.display = 'none';
        }

        function mountFallback() {
            if (document.getElementById('voice-engine-fallback'))
                return;
            const btn = document.createElement('button');
            btn.id = 'voice-engine-fallback';
            btn.type = 'button';
            btn.textContent = '音色引擎';
            Object.assign(btn.style, {
                position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483000',
                border: '1px solid rgba(128,128,128,.35)', background: 'rgba(24,24,27,.96)',
                color: '#e4e4e7', borderRadius: '8px', padding: '6px 12px', fontSize: '12px',
                cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,.35)',
                display: 'none',
            });
            btn.onclick = () => showOverlay();
            document.body.appendChild(btn);
        }

        // The voice-mini speaker button opens a dialog that the conversation
        // pane paints over. Its own dialog stays suppressed here; the same
        // click opens this plugin's overlay instead, which lives on <body> and
        // cannot be covered.
        function note(message) {
            try {
                void fetch(`/voice-engine/ping?hasSlots=1&note=${encodeURIComponent(message)}`).catch(() => undefined);
            }
            catch {
                // diagnostics only
            }
        }

        // Only the voice dialog is ours to touch. Any other 9999-layer surface
        // (workspace pickers, command palettes) must keep its own styling.
        function isVoiceDialog(node) {
            const text = node.textContent ?? '';
            if (/音色|语音|引擎|试听|播报/.test(text))
                return true;
            const width = node.getBoundingClientRect().width;
            return width > 380 && width < 620;
        }

        // The voice-mini speaker dialog mounts inside the conversation header.
        // Whatever clips or shifts it there (transform / filter / containment /
        // overflow on an ancestor), relaxing that chain lets its own fixed
        // positioning resolve against the viewport again.
        function inspectDialog() {
            document.querySelectorAll('[style*="z-index: 9999"], [style*="z-index:9999"]').forEach((node) => {
                if (node.style.zIndex !== '9999')
                    return;
                if (node.closest(`#${OVERLAY_ID}`))
                    return;
                if (!isVoiceDialog(node))
                    return;
                if (node.dataset.veDialog === 'ok')
                    return;
                const rect = node.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const bad = rect.width < 120 || rect.height < 120
                    || rect.left < -8 || rect.top < -8
                    || rect.right > vw + 8 || rect.bottom > vh + 8;
                if (!bad) {
                    node.dataset.veDialog = 'ok';
                    note(`dialog ok ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} vp${vw}x${vh}`);
                    return;
                }
                let el = node.parentElement;
                let depth = 0;
                while (el && el !== document.documentElement && depth < 30) {
                    const cs = getComputedStyle(el);
                    if (cs.transform !== 'none')
                        el.style.transform = 'none';
                    if (cs.filter !== 'none')
                        el.style.filter = 'none';
                    if (cs.contain !== 'none')
                        el.style.contain = 'none';
                    if (cs.willChange !== 'auto' && cs.willChange !== '')
                        el.style.willChange = 'auto';
                    if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible')
                        el.style.overflow = 'visible';
                    el.style.zIndex = '10000';
                    el = el.parentElement;
                    depth += 1;
                }
                note(`dialog fix ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} vp${vw}x${vh} depth${depth}`);
            });
        }

        // Second line of defence for the same dialog: if the click hook ever
        // misses, rank its whole ancestor chain above the scroll pane so the
        // original panel floats instead of sinking behind the messages.
        // Relaxing only z-index is not enough: a scrolling pane above it clips
        // the dialog horizontally, so what lands on screen is a thin strip and
        // the click looks like it did nothing. Strip every clipping mechanism
        // on the ancestor chain, unconditionally, every time the dialog exists.
        function relaxChain(node) {
            let el = node.parentElement;
            let depth = 0;
            const touched = [];
            while (el && el !== document.documentElement && depth < 30) {
                const cs = getComputedStyle(el);
                if (cs.transform !== 'none') {
                    el.style.transform = 'none';
                    touched.push('transform');
                }
                if (cs.filter !== 'none') {
                    el.style.filter = 'none';
                    touched.push('filter');
                }
                if (cs.contain !== 'none') {
                    el.style.contain = 'none';
                    touched.push('contain');
                }
                if (cs.clipPath !== 'none') {
                    el.style.clipPath = 'none';
                    touched.push('clipPath');
                }
                if (cs.willChange !== 'auto' && cs.willChange !== '') {
                    el.style.willChange = 'auto';
                    touched.push('willChange');
                }
                if (cs.overflow !== 'visible') {
                    el.style.overflow = 'visible';
                    touched.push('overflow');
                }
                if (cs.overflowX !== 'visible')
                    el.style.overflowX = 'visible';
                if (cs.overflowY !== 'visible')
                    el.style.overflowY = 'visible';
                // z-index does nothing on a static element, and these header
                // containers are static. Give the chain a painting position
                // before ranking it, or the dialog stays beneath the messages.
                if (cs.position === 'static') {
                    el.style.position = 'relative';
                    touched.push('position');
                }
                if (cs.isolation !== 'auto') {
                    el.style.isolation = 'auto';
                    touched.push('isolation');
                }
                if (cs.mixBlendMode !== 'normal') {
                    el.style.mixBlendMode = 'normal';
                    touched.push('blend');
                }
                if (cs.zIndex !== '2147483000')
                    el.style.zIndex = '2147483000';
                el = el.parentElement;
                depth += 1;
            }
            return { depth, touched: Array.from(new Set(touched)).join(',') };
        }

        function liftForeignOverlay() {
            document.querySelectorAll('[style*="z-index: 9999"], [style*="z-index:9999"]').forEach((node) => {
                if (node.style.zIndex !== '9999')
                    return;
                if (node.closest(`#${OVERLAY_ID}`))
                    return;
                if (!isVoiceDialog(node))
                    return;
                const { depth, touched } = relaxChain(node);
                if (node.dataset.veRelax !== '1') {
                    node.dataset.veRelax = '1';
                    note(`relax depth${depth} touched=[${touched}]`);
                }
            });
        }

        function ping(extra) {
            try {
                const query = new URLSearchParams({ hasSlots: extra?.hasSlots ? '1' : '0' });
                if (extra?.registered)
                    query.set('registered', '1');
                void fetch(`/voice-engine/ping?${query.toString()}`).catch(() => undefined);
            }
            catch {
                // diagnostics only
            }
        }

        // The voice-mini dialog cannot be laid out correctly from inside the
        // conversation header, so the speaker button opens this plugin's
        // viewport-level panel instead. Matching is by title attribute, so no
        // other toolbar button can be captured by accident.
        const SPEAKER_TITLE = /^(语音反馈|Voice feedback)$/;

        function hijackSpeaker() {
            let hooked = 0;
            Array.from(document.querySelectorAll('button[title]')).forEach((btn) => {
                const title = btn.getAttribute('title') ?? '';
                if (!SPEAKER_TITLE.test(title))
                    return;
                hooked += 1;
                if (btn.dataset.veSpeaker === '1')
                    return;
                btn.dataset.veSpeaker = '1';
                btn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopImmediatePropagation();
                    showOverlay();
                }, true);
            });
            const fallback = document.getElementById('voice-engine-fallback');
            if (fallback)
                fallback.style.display = hooked > 0 ? 'none' : 'block';
            return hooked;
        }

        function apply(ctx) {
            const slots = ctx?.slots ?? ctx?.get?.('slots');
            window.__VOICE_ENGINE__ = { loaded: true, hasSlots: Boolean(slots) };
            ping({ hasSlots: Boolean(slots) });
            mountFallback();
            try {
                const sync = () => {
                    hijackSpeaker();
                    liftForeignOverlay();
                    inspectDialog();
                };
                sync();
                new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
                setInterval(sync, 800);
            }
            catch {
                // best effort
            }
            if (!slots)
                return;
            // One entry point only: the speaker button. Registering a second
            // toolbar button here produced two doors to the same room.
            window.__VOICE_ENGINE__.registered = false;
        }

        module.exports = { name: 'dsh-voice-engine', inject: ['slots'], apply };
        return module.exports;
    },
});
