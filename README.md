# dsh-voice-tools

给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 加上 **语音合成** 和 **语音识别**，底层用 DeepSeek 官方的 TTS / ASR 接口。

| 能力 | 入口 | 说明 |
|---|---|---|
| 🔊 语音合成 | 工具 `speak_text` | 模型判断你要语音时**自主调用**；合成结果写成音频文件并返回路径 |
| 🎤 语音识别 | 输入框旁麦克风按钮 | 录音 → 转写 → 文字**追加**到当前草稿（不覆盖已输入内容） |

---

## 快速安装

### 方式一：让 agent 帮你装（推荐）

把下面这句话直接发给你的 DSH agent：

```
帮我安装这个 DSH 插件：https://github.com/N10086/dsh-voice-tools
```

### 方式二：插件市场添加

在 DSH 的 **插件市场 / Discover** 中添加索引地址：

```
https://raw.githubusercontent.com/N10086/dsh-voice-tools/main/market-index.json
```

然后搜索 **Voice tools** 安装。

### 方式三：命令行

```bash
dsh plugin add dsh-voice-tools
```

或直接用 pnpm 装进你的 profile：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add dsh-voice-tools
```

装好后在 **插件管理页** 启用 **语音工具 / Voice tools**，并**刷新页面**。

---

## 前置条件

1. **DeepSeek API Key** — 在 DSH **设置 → 模型** 里保存 `DEEPSEEK_API_KEY`，或设成启动环境变量。
   > 语音识别和合成都会**单独按量计费**，与 token 费用分开。
2. **ffmpeg**（可选）— 只有用到 `speed` 语速调整时才需要。找不到会自动降级为原速，不会报错。

---

## 使用

### 语音合成

直接对 agent 说：

> 帮我把这句话生成语音：世界人民大团结万岁

模型会自动调用：

```
speak_text(
  text: "世界人民大团结万岁",
  voice: "tide",      // stella（女声，默认）| tide（男声）
  speed: 1.2,         // 0.5–2.0，1 为正常
  filename: "my-clip"
)
```

返回：

```
Audio saved to ~/.dsh/voice/my-clip.wav (tide, wav, speed 1.2x, 96044 bytes, about 2s)
```

> 音频**不会**自动挂进对话，工具只返回文件路径。

### 语音识别

点击输入框（模型选择器与发送按钮之间）的麦克风图标：

1. 开始录音 → 图标变红
2. 再次点击停止
3. 识别完成，文字 **追加**到你已输入的内容后面

---

## 配置

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里的 `voice-tools` 行：

```yaml
- id: voice-tools
  name: 'dsh-voice-tools'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    voice: stella        # 默认音色
    format: wav          # wav | pcm
    speed: 1.0           # 默认语速倍率
    ffmpegPath: ''       # 留空则自动查找
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 密钥引用名：先查 DSH 凭据服务，再查环境变量 |
| `voice` | `stella` | 默认音色 |
| `format` | `wav` | 合成输出格式 |
| `speed` | `1.0` | 默认语速倍率（0.5–2.0） |
| `ffmpegPath` | 空 | 指定 ffmpeg；空则查 `~/.dsh/drawai-ffmpeg/**` 与 PATH |

---

## 关于语速（重要）

DeepSeek TTS 官方接口**没有语速参数**（文档原文: *"Speed control ... not supported"*）。

本插件在合成后用 ffmpeg 的 `atempo` 滤镜做后处理——**只改时长，不改音高**，避免"变速变调"的机器感。

| 语速 | 2.32s 原声 → |
|---|---|
| 0.75x | 4.20s |
| 1.25x | 1.84s |
| 1.5x | 2.25s |

采样率始终保持 24000Hz 不变。

---

## 已知限制

- **只有两个音色**：`stella`（女声）/ `tide`（男声），这是官方上限。
- **没有情感参数**：官方两个音色之外无 prosody 控制，本插件不伪造该能力。
- **语言不可选**：官方按文本**自动识别**，支持中/粤/英/日/韩/马来/阿/印尼/泰/越。
- **ASR 上限**：单次 ≤120 秒、≤8 MiB；录满 120 秒会自动停止提交。
- **仅 wav 支持语速**；`pcm` 是裸数据流，不处理。
- **转录文字进入草稿**但不会自动发送。

---

## 端点

| 用途 | 地址 |
|---|---|
| TTS | `POST https://api.deepseek.com/v1/tools/tts` |
| ASR | `POST https://api.deepseek.com/v1/tools/asr` |
| 本机转写路由 | `POST /voice-tools/transcribe`（接收 `audio/wav`） |

---

## 开发说明

本包**不 `import` 任何 `@deepseek-ai/*` 包**。原因：安装在 profile 里的插件从 profile 目录解析模块，而 DSH 自带的包在应用归档（`app.asar`）内部，裸 import 会在加载时失败。所有逻辑通过 Cordis 上下文和原生 `fetch` 实现。

```
dsh-voice-tools/
├── lib/index.js          # Host 半：speak_text 工具 + 转写路由 + ffmpeg 语速处理
├── client/index.js       # 浏览器半：麦克风按钮
├── cordis.patch.yml      # Bundle 补丁
├── locale/               # 插件市场显示文案
└── market-index.json     # 插件市场索引（format 1）
```

## License

MIT
