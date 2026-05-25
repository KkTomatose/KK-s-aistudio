# AI 电台 — 个性化智能 DJ

基于 [Claudio](https://github.com/wutongyuonce/claudio) 二次开发的私人 AI 电台。DeepSeek 驱动 DJ 选歌 + Edge TTS 语音播报 + 网易云音乐播放 + 实时同步歌词。

## 功能特性

- **AI DJ**：DeepSeek 根据时间、天气、心情自动选歌并生成播报词
- **动态专辑背景**：播放时自动显示专辑封面作为全屏背景
- **实时歌词**：同步滚动歌词，高亮居中，双击跳转，按封面取色
- **DJ 歌曲介绍**：手动点歌时 DJ 自动介绍歌曲背景和风格
- **一键填充歌单**：点击 + 按钮 AI 自动推荐歌曲
- **Per-song 歌词偏移**：左右箭头微调歌词同步，自动记忆

## 技术栈

- **后端**：Node.js + Express + WebSocket
- **前端**：原生 HTML/CSS/JS（PWA）
- **AI**：DeepSeek API（兼容 OpenAI 格式）
- **TTS**：Edge TTS（免费）
- **音乐源**：NeteaseCloudMusicApi
- **天气**：和风天气 API

## 快速开始

### 1. 安装依赖

```bash
cd claudio
pnpm install
pip install edge-tts
```

要求：Node.js ≥ 22，pnpm，Python ≥ 3.10

### 2. 配置

复制 `.env.example` 为 `.env`，填入 API Key：

```env
LLM_API_KEY=你的DeepSeek_Key
QWEATHER_KEY=你的和风天气_Key
QWEATHER_LOCATION=你的城市代码
```

### 3. 启动

```bash
# 终端1：启动网易云API
npx NeteaseCloudMusicApi

# 终端2：启动Claudio
node server.js
```

浏览器打开 `http://localhost:8080`

### 4. 登录网易云（可选，VIP歌曲需要）

```bash
node scripts/ncm-login.js
```

## 项目结构

```
claudio/
├── server.js          # Express + WebSocket 服务器
├── src/               # 后端模块
│   ├── claude.js      # LLM 调用
│   ├── context.js     # DJ 上下文构建
│   ├── tts.js         # TTS 合成
│   ├── ncm.js         # 网易云 API
│   ├── weather.js     # 天气
│   ├── scheduler.js   # 定时任务
│   ├── state.js       # SQLite 状态
│   └── analyzer.js    # 歌单分析
├── pwa/               # 前端 PWA
│   ├── index.html     # 主页面（含内联 CSS）
│   └── app.js         # 前端逻辑
├── prompts/           # DJ 人设
├── user/              # 用户数据（歌单、口味）
└── .env.example       # 配置模板
```

## 致谢

本项目基于 [Claudio](https://github.com/wutongyuonce/claudio) 开发，许可证：MIT。
前端设计借鉴了原项目的设计风格。

## 许可证

MIT
