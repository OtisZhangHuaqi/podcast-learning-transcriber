# Architecture / 架构说明

## 进程边界

```text
Electron renderer
  └─ 受限IPC（preload）
      └─ Electron main process
          ├─ 链接识别与RSS解析
          ├─ 后台任务队列与暂停/重试
          ├─ 凭据解密与DeepSeek请求
          ├─ 本地知识库索引/检索
          └─ 原生工具进程
              ├─ yt-dlp
              ├─ FFmpeg
              └─ whisper.cpp
```

渲染进程不直接访问Node.js、文件系统或完整API Key。主进程通过预加载脚本暴露有限IPC接口。

## 主要模块

- `src/main.js`：窗口、设置、任务队列、资源复用和整体编排。
- `src/services/resolver.js`：链接元数据、Apple目录、RSS/Atom和单集匹配。
- `src/services/video.js`：yt-dlp视频信息、字幕和音频处理。
- `src/services/transcriber.js`：FFmpeg转换、模型定位、Whisper与长音频切片。
- `src/services/deepseek.js`：可选背景词表、结构化JSON、受约束校正、纪要和问答。
- `src/services/knowledge.js`：本地文件分块、索引与检索。
- `src/platform/`：跨平台路径、二进制定位和运行时差异。

## 可靠性原则

- 发布者字幕优先于ASR。
- 原始音频和原始字幕永久保留，校正稿单独输出。
- 已下载资源按GUID、媒体URL或来源URL复用。
- DeepSeek结构化校正按批次保存检查点；单批异常时保留原文并继续。
- 知识库答案必须有本地片段支持，资料不足时拒答。
- 所有用户内容保持在用户选择的输出目录，除用户明确启用的API文本调用外不上传。

## 信任边界

平台页面、RSS描述、字幕、网页证据和知识库文本均视为不可信数据，不能作为系统指令执行。外部工具运行参数使用参数数组传递，避免通过shell拼接用户输入。

