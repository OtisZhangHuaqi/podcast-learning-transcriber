const fs = require('fs');
const path = require('path');

function runtimeKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `darwin-${arch}`;
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return `${platform}-${arch}`;
}

function resourceRoot({ packaged, resourcesPath, appPath }) {
  return packaged ? resourcesPath : path.join(appPath, 'vendor');
}

function assertTool(file, label) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(`安装包缺少 ${label} 组件：${file || '未配置路径'}`);
  }
  if (process.platform !== 'win32') {
    try { fs.accessSync(file, fs.constants.X_OK); } catch {
      throw new Error(`${label} 没有执行权限：${file}`);
    }
  }
  return file;
}

function findRecursive(directory, pattern) {
  if (!directory || !fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findRecursive(full, pattern);
      if (nested) return nested;
    } else if (pattern.test(entry.name)) return full;
  }
  return null;
}

function createBinaryLocator(context) {
  const root = resourceRoot(context);
  const key = runtimeKey(context.platform, context.arch);
  const modernRoot = path.join(root, key);
  const isWindows = context.platform === 'win32';

  function whisperRoot() {
    const modern = path.join(modernRoot, 'whisper');
    if (fs.existsSync(modern)) return modern;
    return path.join(root, 'whisper');
  }

  function whisper() {
    const pattern = isWindows ? /^whisper-cli\.exe$/i : /^whisper-cli$/;
    return assertTool(findRecursive(whisperRoot(), pattern), 'whisper.cpp 转录');
  }

  function ffmpeg() {
    const bundled = path.join(modernRoot, 'ffmpeg', isWindows ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(bundled)) return assertTool(bundled, 'FFmpeg');
    if (context.ffmpegFallback) return assertTool(context.ffmpegFallback.replace('app.asar', 'app.asar.unpacked'), 'FFmpeg');
    return assertTool(bundled, 'FFmpeg');
  }

  function ytDlp() {
    const modern = path.join(modernRoot, 'yt-dlp', isWindows ? 'yt-dlp.exe' : 'yt-dlp');
    if (fs.existsSync(modern)) return assertTool(modern, 'yt-dlp 视频处理');
    const legacy = path.join(root, 'yt-dlp', 'yt-dlp.exe');
    return assertTool(isWindows ? legacy : modern, 'yt-dlp 视频处理');
  }

  return { key, root, whisperRoot, whisper, ffmpeg, ytDlp };
}

module.exports = { createBinaryLocator, findRecursive, resourceRoot, runtimeKey };
