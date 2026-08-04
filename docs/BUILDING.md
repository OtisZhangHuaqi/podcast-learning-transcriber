# Building from source / 从源码构建

## 通用要求

- Node.js 22
- pnpm（通过Corepack管理）
- Git
- 足够的磁盘空间：完整模型与双平台构建可能需要15GB以上临时空间

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

## 模型

`scripts/prepare-models.sh`从whisper.cpp公开模型分发地址下载：

- `ggml-small.bin`
- `ggml-medium.bin`
- `ggml-large-v3-turbo.bin`

模型位于`vendor/models/`，被`.gitignore`排除，不得提交到源码仓库。

## Windows x64

GitHub Actions工作流会：

1. 安装锁定的Node依赖；
2. 下载三个Whisper模型；
3. 下载固定版本的whisper.cpp Windows x64二进制和yt-dlp；
4. 运行自动测试；
5. 生成`win-unpacked`完整可运行目录；
6. 创建ZIP并生成SHA-256。

完整包超过普通NSIS便携EXE的可靠大小范围，因此正式交付为“完整目录ZIP”。用户必须完整解压，不能直接在压缩包内运行。

## macOS Universal

GitHub Actions分别在Apple Silicon和Intel runner上构建whisper.cpp工具，再由Electron Builder生成Universal应用。工作流同时准备架构对应的FFmpeg与yt-dlp，执行资源、架构与ad-hoc签名审计，并生成DMG。

该DMG没有Developer ID签名或Apple公证。首次启动可能需要用户手动允许。CI构建成功不等同于所有真实Mac硬件已经验证。

## 本地开发运行

`pnpm start`要求当前平台对应的whisper、FFmpeg、yt-dlp和模型资源已经存在。若只开发不涉及外部工具的UI或逻辑，可以通过单元测试和mock验证。

## 版本规则

每次功能、修复或依赖升级必须：

1. 更新`package.json`语义版本；
2. 同步Windows和macOS工作流产物名称；
3. 更新`CHANGELOG.md`；
4. 运行共享测试；
5. 分别报告Windows、macOS CI和macOS真实设备验证状态。

