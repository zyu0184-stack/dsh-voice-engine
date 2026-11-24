# dsh-voice-engine

本地音色引擎插件。一个常驻的 F5-TTS 进程，加一层音色库，供 DSH 里的朗读插件和云端克隆插件共用。

## 它解决什么问题

F5-TTS 是本地跑的 Python 服务，一次要加载 1.35 GB 模型。以前每个用到它的地方各管一段：

- 朗读插件把引擎路径写死在代码里，服务挂了就地重拉；
- 云端克隆插件的音色在服务商那边，本地只有一份 `links.json`，加音色得手工跑上传脚本。

这个插件把「引擎进程 + 音色库」收成一层：

| 关注点 | 分散在各处 | 收成一层之后 |
| --- | --- | --- |
| 引擎进程 | 每个插件自己 spawn | 一处 spawn，单飞防并发 |
| 音色登记 | 改 `voices.json` 后重启 | mtime 变了自动重载 |
| 加音色 | 手工切音频、抄逐字稿 | 传整段音频，自动转写并挑片段 |
| 试听 | 写脚本跑一遍 | 面板里点一下 |
| 推到云端 | 手工上传脚本 | 面板按钮，或 `POST /duet/push` |
| 设为朗读音色 | 手改配置 | 面板按钮，或 `POST /activate` |

引擎自己的 HTTP 协议没变，所以已有的客户端不用改。

## 依赖

- Node.js 20+
- DSH（`@deepseek-ai/cordis` 运行时）
- 一个装好 F5-TTS 的 Python 环境，目录结构：

```
<engineRoot>/
├── .venv/                 # 含 f5-tts、torch、soundfile
├── tools/f5_server.py     # HTTP 包装，暴露 /health /tts /voices
├── voices.json            # 音色库
├── refs/                  # 参考音频
└── work/                  # 日志、缓存
```

`f5_server.py` 和配套脚本见 [f5-voice-clone-workflow](https://github.com/zyu0184-stack/f5-voice-clone-workflow)。

## 装法

插件目录挂进 profile 的 `node_modules`，再由 `dsh.profile.bundles` 拉起来。

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-voice-engine": "file:/absolute/path/to/plugins/dsh-voice-engine"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-voice-engine"]
    }
  }
}
```

配置写在同一个 profile 的 `cordis.patch.yml`，按 id 覆盖插件的默认值。凭证只放这里，不进插件包：

```yaml
- id: dsh-voice-engine
  config:
    engineRoot: /absolute/path/to/voice-engine
    duetUploadUrl: https://<your-endpoint>/voices/upload
    duetAuthorization: '<your-token>'
```

改完重启 DSH 生效。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `engineRoot` | `~/voice-engine` | 引擎工作目录，含 `.venv`、`tools/f5_server.py`、`voices.json` |
| `python` | 空（自动推） | 显式指定解释器；空时按平台取 `.venv/Scripts/pythonw.exe`（无则 `python.exe`）或 `.venv/bin/python` |
| `port` | `18231` | F5 服务端口 |
| `autoStart` | `true` | 插件加载时服务不在线就拉起来 |
| `audioCache` | `~/.dsh/voice-engine/audio` | 试听文件落盘目录 |
| `bootTimeoutMs` | `120000` | 等模型进显存的上限 |
| `synthTimeoutMs` | `300000` | 单次合成上限 |
| `duetDir` | `~/.dsh/dsh-duet` | 云端克隆插件的数据目录，读 `voices/links.json` |
| `duetUploadUrl` | 空 | 上传端点；空则不显示推送按钮 |
| `duetAuthorization` | 空 | 上传凭证；空则不显示推送按钮 |
| `syncVoiceMini` | `true` | `/activate` 时顺手改 `dsh-voice-mini` 的配置 |

Windows 上解释器优先用 `pythonw.exe`（GUI 子系统），拉起时不会闪一个控制台窗口。

## HTTP 接口

统一前缀 `/voice-engine`。这几个路由不需要 DSH 的会话 cookie。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 一次拿全：引擎是否在跑、健康信息、音色列表、云端列表 |
| GET | `/health` | 引擎 `/health` 直通，离线回 `{ok:false}` |
| POST | `/start` | 手动拉起引擎，等就绪才返回 |
| GET | `/voices` | 音色数组 |
| POST | `/voices` | `{key,name,ref,refText,speed,nfe,cfg}`，按 key upsert |
| POST | `/voices/delete` | `{key}` |
| POST | `/upload` | 裸 body 传音频，`?name=` 带文件名 → `{uploadId,bytes,file}` |
| POST | `/voices/analyze` | `{uploadId}` → 立即回 `{jobId}`，后台转写并挑片段 |
| GET | `/voices/job` | `?id=` → `{status,result}` 或 `{status,error}` |
| POST | `/voices/create` | `{uploadId,key,name,start,end,refText}` → 切片、写 `voices.json` |
| GET | `/ref-audio` | `?key=` → 该音色的参考音频（wav 流） |
| POST | `/preview` | `{text,voice,speed}` → 合成到缓存，回 `{url,ms,bytes}` |
| GET | `/audio/<file>` | 取试听/合成文件 |
| POST | `/activate` | `{key}` → 把 `dsh-voice-mini` 切成 `backend:clone, voiceMode:fixed, voice:key` |
| GET | `/duet` | 云端音色清单与选中项 |
| POST | `/duet/push` | `{key}` → 转 24 kHz 单声道 mp3 上传，轮询到 ready，写 `links.json` |
| GET | `/panel` | 面板本体（纯 DOM 单页，可单独在浏览器打开） |
| GET | `/ping` | 浏览器半的加载回执，写 `work/client-ping.log` |

`key` 只允许 `[A-Za-z0-9_-]`，1–64 字符。

## 加一个音色

整段音频进去，音色出来。分析在后台跑，面板每 2 秒轮一次，长音频也能等。

```
选文件 → POST /upload            原始音频落到 work/uploads/
       → POST /voices/analyze    后台 spawn add_voice.py
            ffmpeg 转 32 kHz 单声道
            faster-whisper 转写（默认 small，cpu int8）
            按 2.5 s 步长在转写段里滑窗，算能量覆盖 + 文本密度
            去重叠后按分数返回前 8 个候选
       → GET /voices/job         轮询，拿到候选列表
       → POST /voices/create     切 9–12 s、降噪、响度归一，写 voices.json
```

候选里每一条都带起止秒数、覆盖率和转写文本。面板自动填第一条，也可以点别的，或者手填秒数。逐字稿决定克隆像不像，转写有错字就手改——参考文本和参考音频对不上，F5 只能照错的念。

切出来的文件是 `<engineRoot>/refs/<key>.wav`：`highpass=f=70, afftdn=nr=10:nf=-45, loudnorm=I=-19:TP=-2:LRA=6`，32 kHz 单声道。

不需要转写时跳过 `/voices/analyze`，直接 `/voices/create` 给 `start`/`end`。`add_voice.py` 也可以单独用：

```bash
.venv/Scripts/python.exe scripts/add_voice.py analyze --src 长音频.mp3
.venv/Scripts/python.exe scripts/add_voice.py cut --src 长音频.mp3 --start 48 --end 57.5 --out refs/new.wav
.venv/Scripts/python.exe scripts/add_voice.py text --src 长音频.mp3 --start 48 --end 57.5
```

`analyze` 的输出是 JSON：`duration` / `speech_seconds` / `segments` / `candidates[]` / `transcript[]`。换更准的模型用 `--model turbo`（CPU 上慢三到四倍）。

## 面板

面板挂在 `<body>` 下，层级 `2147483000`，尺寸 `min(520px, 92vw) × min(760px, 88vh)`，点遮罩空白或按 Esc 关闭。

入口有两个，正常只有一个可见：

1. 会话标题栏那个语音反馈喇叭。浏览器半按 `title` 属性精确匹配 `语音反馈` / `Voice feedback`，在 capture 阶段接管点击，打开本插件的面板。
2. 右下角浮动按钮。只在找不到上面那个喇叭时出现，用来兜底。

面板内容：

- 状态行：端口、设备、累计调用数、音色数
- 引擎离线时出现「启动引擎」
- 音色列表：`▶ 试听`、`用这个`（切成朗读音色）、`→duet`（推云端，需配置）
- 新增音色：选文件 → 上传并分析 → 候选片段 → 起点/终点/逐字稿 → 生成音色
- 试听区：文本框 + 音色下拉 + 「合成并播放」
- 云端区：远端音色状态与当前选中项

浏览器半只依赖 `react` 与 `react/jsx-runtime`，通过 `window.__ModuleLoader__` 注册；宿主半在 `webServer` fiber 就绪后挂路由，避免与 webserver 并行 boot 时的竞态。

## 目录

```
plugins/dsh-voice-engine/
├── package.json          # name / dsh.bundle.patch / dsh.client
├── cordis.patch.yml      # insert 自己（中性默认值）
├── lib/index.js          # host：引擎生命周期 + 音色库 + 路由 + 面板 HTML
├── lib/client.js         # 浏览器：__ModuleLoader__ 打包，只 require react
├── scripts/add_voice.py  # 转写、挑片段、切参考音频
├── open-panel.mjs        # 独立打开面板的小脚本
└── test-host.mjs         # 不起 DSH，裸 http 验路由
```

## 与消费方的关系

```
                ┌─────────────────────┐
                │  dsh-voice-engine   │
                │  引擎进程 / 音色库   │
                └──────────┬──────────┘
              spawn /tts   │   POST /activate        POST /duet/push
        ┌──────────────────┴────────────┐
        ▼                               ▼
   朗读插件                        云端克隆插件
   （clone 后端）                  （links.json + 远端）
```

朗读插件拿音色键调 F5 的 `/tts`；云端克隆插件只认远端音色 id，所以推送这一步走网络。

## 验证

不重启 DSH 先验宿主逻辑：

```bash
node test-host.mjs
```

它会在 18999 端口起一个裸 http 服务，逐个打印 `/state`、`/voices`、`/duet`、`/preview`、`/panel` 的实际返回。

## 许可

MIT
