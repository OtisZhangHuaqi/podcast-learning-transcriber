# Third-party notices

The original source code in this repository is licensed under the MIT License. Third-party software, model weights and downloadable release binaries retain their own licenses.

| Component | Purpose | Upstream and license |
|---|---|---|
| Electron | Desktop runtime | https://github.com/electron/electron — MIT |
| whisper.cpp / ggml | Local ASR inference | https://github.com/ggml-org/whisper.cpp — MIT |
| OpenAI Whisper models | Small, Medium and Large v3 Turbo weights | https://github.com/openai/whisper — consult the upstream repository and model distribution terms |
| fast-xml-parser | RSS/Atom XML parsing | https://github.com/NaturalIntelligence/fast-xml-parser — MIT |
| FFmpeg | Audio extraction, conversion and segmentation | https://ffmpeg.org/legal.html — licensing depends on build configuration; FFmpeg is primarily LGPL with optional GPL components |
| ffmpeg-static | Platform FFmpeg binary distribution used by this project | https://github.com/eugeneware/ffmpeg-static — GPL-3.0; bundled binary provenance and license files should be inspected for each release |
| yt-dlp | Public video metadata, subtitle and audio extraction | https://github.com/yt-dlp/yt-dlp — source primarily Unlicense; PyInstaller executables include additional components and are distributed under GPLv3+ as documented upstream |

DeepSeek is an optional external API configured by the user. It is not an open-source model bundled by this repository and is governed by DeepSeek's service terms. Audio transcription remains local; optional text-processing features send only the required metadata or text to the user's configured API account.

Downstream distributors are responsible for preserving all applicable copyright notices, license texts and source-offer obligations for the exact binaries they redistribute.
