# Podcast Learning Transcriber / 播客学习助手

一个本地优先的 Windows 与 macOS 桌面应用：从播客或公开视频链接识别节目、优先提取发布者字幕，在没有字幕时使用本地 Whisper 转录，并将结果整理为可检索的个人知识库。

> 项目仍处于早期阶段。不同平台会调整页面、登录和反爬策略，链接解析不保证永久可用。请只处理你有权访问、下载和转录的内容。

## 主要功能

- 自动识别 Apple Podcasts、Spotify、小宇宙、公开 RSS、YouTube 与公开 Bilibili 链接。
- 尝试从节目页面反查公开 RSS，并匹配具体单集。
- 优先下载发布者提供的 TXT、SRT 或 VTT，避免不必要的语音识别。
- 没有字幕时，通过 `yt-dlp`/RSS 获取音频，并使用本地 `whisper.cpp` 转录。
- 支持 Small、Medium 和 Large v3 Turbo Whisper 模型。
- 长音频切片、多任务排队、暂停/继续、失败任务重试和已有资源复用。
- 可选调用用户自己的 DeepSeek API，生成背景词表、受约束校正和结构化学习纪要。
- 本地知识库跨节目检索问答；资料不足时拒绝使用外部知识补答。
- 保存原始音频、原始字幕、校正版文本、诊断信息和学习纪要，便于审计。

## 工作流程

```text
用户粘贴链接
  → 识别平台并尝试查找公开 RSS
  → 匹配单集与发布者字幕
      ├─ 有字幕：保存原始字幕
      └─ 无字幕：获取音频 → 本地 Whisper 转录
  → 可选 DeepSeek 背景词表与高置信度校正
  → 可选结构化学习纪要
  → 写入本地知识库并提供证据引用问答
```

## 支持的操作系统

| 平台 | 架构 | 交付形式 | 验证状态 |
|---|---|---|---|
| Windows 10/11 | x64 | 完整可运行目录 ZIP | CI构建与自动测试；需要完整解压后运行 |
| macOS | Apple Silicon + Intel Universal | DMG | CI构建、架构与签名审计；真实设备覆盖仍有限 |

Linux目前没有正式发行包，但核心服务大部分使用跨平台JavaScript。

## 隐私与API Key

- 音频转录在本机完成，音频不会发送给DeepSeek。
- 启用DeepSeek功能时，必要的节目元数据、背景文本或逐字稿片段会发送到DeepSeek API。
- API Key由用户在应用内输入，使用Electron `safeStorage`调用操作系统凭据加密能力保存；不会写入项目目录、知识库文件或GitHub Actions。
- 应用不包含开发者API Key，也不要求共享账户。
- 更完整的数据流说明见 [PRIVACY.md](PRIVACY.md)。

## 从源码运行

要求：

- Node.js 22
- pnpm 10（可通过Corepack启用）
- Git

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

开发模式不会自动准备所有本地模型和原生工具。完整构建步骤见 [docs/BUILDING.md](docs/BUILDING.md)。

## 构建发行包

仓库包含两个手动触发的GitHub Actions工作流：

- `Build Windows release package`
- `Build macOS Universal release package`

它们会下载/构建所需的开源工具与Whisper模型、运行测试，并上传完整发行包。构建产物很大，运行工作流会消耗GitHub Actions时间与Artifact存储额度。

macOS包使用ad-hoc签名，没有Apple Developer ID公证。首次打开可能需要在“系统设置 → 隐私与安全性”中明确允许。

## 核心开源组件

| 组件 | 用途 | 许可证说明 |
|---|---|---|
| Electron | 桌面应用运行时 | MIT |
| whisper.cpp | 本地Whisper推理 | MIT |
| OpenAI Whisper模型权重 | Small/Medium/Large v3 Turbo ASR | 以模型上游许可证为准 |
| FFmpeg / ffmpeg-static | 音频提取、转码和切片 | 发行二进制可能适用LGPL/GPL；当前npm包装项目为GPL-3.0 |
| yt-dlp | 视频元数据、字幕和音频提取 | 源码主要为Unlicense；PyInstaller发行文件包含GPLv3+组件 |
| fast-xml-parser | RSS/Atom解析 | MIT |
| DeepSeek API | 可选文本处理服务 | 非本项目捆绑模型；适用DeepSeek服务条款 |

完整声明与上游链接见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库的原创源码采用MIT许可证；这不会改变第三方程序、模型或发行二进制各自的许可证。

## 已知限制

- Bilibili、小红书、YouTube等平台可能因Cookie、地区、VPN、登录要求或风控失败。
- 平台页面能被解析不等于发布者允许下载；使用者负责确认内容权利。
- 自动字幕和ASR可能出现人名、公司名、中英混杂与数字错误，应保留原始稿并人工复核。
- 当前不提供说话人分离。
- DeepSeek调用会产生由用户承担的API费用。
- 本地知识库是轻量级文件检索实现，不适合敏感组织级数据治理场景。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题不要提交公开Issue，请按照 [SECURITY.md](SECURITY.md) 使用GitHub私密漏洞报告。

## 许可证

本项目原创源码采用 [MIT License](LICENSE)。发行包中包含或调用的第三方组件继续受其各自许可证约束。
