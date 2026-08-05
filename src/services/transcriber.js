const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const { ensureDirectory, formatSeconds } = require('./utils');
const { nullDevice, spawnOptions } = require('../platform/runtime');

let configuredFfmpeg = null;

function configureFfmpeg(file) {
  configuredFfmpeg = file || null;
}

const MODELS = {
  small: {
    label: 'Small 多语言（内置，推荐）',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    file: 'ggml-small.bin'
  },
  medium: {
    label: 'Medium 多语言（更准确，约1.5GB）',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    file: 'ggml-medium.bin'
  },
  turbo: {
    label: 'Large v3 Turbo（高质量，约1.6GB）',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    file: 'ggml-large-v3-turbo.bin'
  }
};

function emit(send, patch) {
  send({ timestamp: Date.now(), ...patch });
}

async function downloadFile(url, destination, send, stage, signal) {
  ensureDirectory(path.dirname(destination));
  const temp = `${destination}.download`;
  let response;
  try {
    response = await fetch(url, { redirect: 'follow', signal });
  } catch (error) {
    const reason = error?.cause?.message || error?.cause?.code || error.message;
    throw new Error(`下载连接失败：${url}\n${reason}`);
  }
  if (!response.ok || !response.body) throw new Error(`下载失败 (${response.status})：${url}`);
  const total = Number(response.headers.get('content-length') || 0);
  const file = fs.createWriteStream(temp);
  const reader = response.body.getReader();
  let downloaded = 0;
  const started = Date.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(Buffer.from(value));
      downloaded += value.byteLength;
      const elapsed = Math.max(0.1, (Date.now() - started) / 1000);
      const speed = downloaded / elapsed;
      const progress = total ? downloaded / total : 0;
      emit(send, {
        stage,
        progress,
        detail: total
          ? `${(downloaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
          : `${(downloaded / 1048576).toFixed(1)} MB`,
        etaSeconds: total && speed ? Math.max(0, (total - downloaded) / speed) : null
      });
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }
  fs.renameSync(temp, destination);
  return destination;
}

function runProcess(command, args, handlers = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions()
    });
    handlers.onChild?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      const text = data.toString('utf8');
      stdout += text;
      handlers.onOutput?.(text, 'stdout');
    });
    child.stderr.on('data', (data) => {
      const text = data.toString('utf8');
      stderr += text;
      handlers.onOutput?.(text, 'stderr');
    });
    child.on('error', (cause) => {
      const error = new Error(`${handlers.errorMessage || '无法启动处理程序'}\n${cause.message}`);
      error.code = cause.code || 'PROCESS_SPAWN_FAILED';
      error.cause = cause;
      error.processDetails = {
        executable: path.basename(command),
        event: 'spawn',
        code: cause.code || null
      };
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const diagnostic = stderr.trim().slice(-12000) || stdout.trim().slice(-12000) || '子进程没有输出诊断信息';
        const status = signal ? `信号 ${signal}` : `退出码 ${code}`;
        const error = new Error(`${handlers.errorMessage || '处理程序执行失败'}（${status}）\n${diagnostic}`);
        error.code = 'PROCESS_EXIT_FAILED';
        error.processDetails = {
          executable: path.basename(command),
          event: 'close',
          exitCode: code,
          signal: signal || null,
          stderrTail: stderr.slice(-12000),
          stdoutTail: stdout.slice(-4000)
        };
        reject(error);
      }
    });
  });
}

function locateFfmpeg() {
  if (configuredFfmpeg) return configuredFfmpeg;
  if (!ffmpegStatic) throw new Error('找不到内置 FFmpeg');
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

async function probeDuration(inputPath) {
  const result = await runProcess(locateFfmpeg(), [
    '-hide_banner', '-i', inputPath,
    '-t', '0.01', '-f', 'null', nullDevice()
  ], {
    errorMessage: '无法读取音频信息'
  });
  const match = `${result.stdout}\n${result.stderr}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

async function convertToWav(inputPath, outputPath, duration, send, onChild) {
  const started = Date.now();
  await runProcess(locateFfmpeg(), [
    '-y', '-hide_banner', '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath
  ], {
    onChild,
    errorMessage: '音频格式转换失败',
    onOutput(text) {
      const matches = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const match = matches.at(-1);
      if (!match || !duration) return;
      const current = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      const progress = Math.min(1, current / duration);
      const elapsed = (Date.now() - started) / 1000;
      emit(send, {
        stage: 'convert', progress,
        detail: `${formatSeconds(current)} / ${formatSeconds(duration)}`,
        etaSeconds: progress > 0.02 ? elapsed / progress - elapsed : null
      });
    }
  });
}

async function ensureModel(modelKey, dataDirectory, send, signal, bundledModelsDirectory) {
  const model = MODELS[modelKey] || MODELS.small;
  const bundled = bundledModelsDirectory
    ? path.join(bundledModelsDirectory, model.file)
    : null;
  if (bundled && fs.existsSync(bundled) && fs.statSync(bundled).size > 50 * 1024 * 1024) {
    emit(send, {
      stage: 'model', progress: 1,
      detail: `使用安装包内置模型：${model.label}`,
      etaSeconds: 0
    });
    return bundled;
  }
  const destination = path.join(dataDirectory, 'models', model.file);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 50 * 1024 * 1024) return destination;
  await downloadFile(model.url, destination, send, 'model', signal);
  return destination;
}

async function transcribe({ whisperExecutable, modelPath, wavPath, outputPrefix, prompt, duration, send, onChild, threads, detailPrefix = '' }) {
  const started = Date.now();
  const logicalCpus = os.cpus()?.length || 4;
  const threadCount = Math.max(2, Number(threads) || Math.min(8, Math.max(2, logicalCpus - 2)));
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', 'auto',
    '-t', String(threadCount),
    '-otxt', '-osrt',
    '-of', outputPrefix,
    '--print-progress',
    '--prompt', String(prompt || '').slice(0, 1200)
  ];
  emit(send, { stage: 'transcribe', progress: 0, detail: `${detailPrefix}本地转录启动（${threadCount} 个 CPU 线程）` });
  let observed = 0;
  await runProcess(whisperExecutable, args, {
    onChild,
    errorMessage: '本地 Whisper 转录失败',
    onOutput(text) {
      const percentMatches = [...text.matchAll(/progress\s*=\s*(\d+)%/gi)];
      if (percentMatches.length) observed = Number(percentMatches.at(-1)[1]) / 100;
      const timeMatches = [...text.matchAll(/\[(\d+):(\d+):(\d+(?:\.\d+)?)\s*-->/g)];
      if (timeMatches.length && duration) {
        const match = timeMatches.at(-1);
        const current = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        observed = Math.max(observed, Math.min(0.99, current / duration));
      }
      if (!observed) return;
      const elapsed = (Date.now() - started) / 1000;
      emit(send, {
        stage: 'transcribe', progress: observed,
        detail: `${detailPrefix}已完成 ${Math.round(observed * 100)}%`,
        etaSeconds: observed > 0.01 ? elapsed / observed - elapsed : null
      });
    }
  });
  const outputs = { txt: `${outputPrefix}.txt`, srt: `${outputPrefix}.srt` };
  for (const [format, file] of Object.entries(outputs)) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      const error = new Error(`本地 Whisper 未生成有效的 ${format.toUpperCase()} 文件：${file}`);
      error.code = 'WHISPER_OUTPUT_MISSING';
      throw error;
    }
  }
  return outputs;
}

function parseSrtTimestamp(value) {
  const match = String(value).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

function formatSrtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function readSrt(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
    const timing = lines.shift()?.match(/^(.+?)\s+-->\s+(.+?)$/);
    if (!timing) return null;
    return { start: parseSrtTimestamp(timing[1]), end: parseSrtTimestamp(timing[2]), text: lines.join('\n').trim() };
  }).filter((cue) => cue?.text);
}

async function createAudioParts(wavPath, directory, duration, chunkSeconds, overlapSeconds, send, onChild) {
  ensureDirectory(directory);
  const parts = [];
  const count = Math.ceil(duration / chunkSeconds);
  for (let index = 0; index < count; index += 1) {
    const coreStart = index * chunkSeconds;
    const coreEnd = Math.min(duration, coreStart + chunkSeconds);
    const extractStart = Math.max(0, coreStart - overlapSeconds);
    const extractEnd = Math.min(duration, coreEnd + overlapSeconds);
    const filePath = path.join(directory, `part-${String(index + 1).padStart(3, '0')}.wav`);
    await runProcess(locateFfmpeg(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(extractStart), '-i', wavPath, '-t', String(extractEnd - extractStart),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', filePath
    ], { onChild, errorMessage: `无法创建音频切片 ${index + 1}/${count}` });
    parts.push({ index, count, filePath, coreStart, coreEnd, extractStart, duration: extractEnd - extractStart });
    emit(send, { stage: 'segment', progress: (index + 1) / count, detail: `准备音频切片 ${index + 1}/${count}` });
  }
  return parts;
}

function mergePartSubtitles(parts, outputPrefix) {
  const cues = [];
  for (const part of parts) {
    for (const cue of readSrt(part.srt)) {
      const start = cue.start + part.extractStart;
      const end = cue.end + part.extractStart;
      const midpoint = (start + end) / 2;
      if (midpoint < part.coreStart || (part.index < part.count - 1 && midpoint >= part.coreEnd)) continue;
      cues.push({ start, end, text: cue.text });
    }
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const srt = `${cues.map((cue, index) => (
    `${index + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`
  )).join('\n\n')}\n`;
  const txt = `${cues.map((cue) => `[${formatSrtTimestamp(cue.start)}] ${cue.text}`).join('\n')}\n`;
  fs.writeFileSync(`${outputPrefix}.srt`, srt, 'utf8');
  fs.writeFileSync(`${outputPrefix}.txt`, txt, 'utf8');
  return { txt: `${outputPrefix}.txt`, srt: `${outputPrefix}.srt` };
}

async function transcribeSegmented(options) {
  const {
    whisperExecutable, modelPath, wavPath, outputPrefix, prompt, duration, send, onChild,
    workers = 2, threadsPerWorker = 4, chunkMinutes = 12, overlapSeconds = 20, waitIfPaused
  } = options;
  const partsDirectory = `${outputPrefix}-parts`;
  const parts = await createAudioParts(
    wavPath, partsDirectory, duration, chunkMinutes * 60, overlapSeconds, send, onChild
  );
  const progress = new Map(parts.map((part) => [part.index, 0]));
  let cursor = 0;
  const started = Date.now();
  const worker = async () => {
    while (cursor < parts.length) {
      const part = parts[cursor++];
      await waitIfPaused?.(`等待继续后处理切片 ${part.index + 1}/${part.count}`);
      const prefix = path.join(partsDirectory, `result-${String(part.index + 1).padStart(3, '0')}`);
      const outputs = await transcribe({
        whisperExecutable, modelPath, wavPath: part.filePath, outputPrefix: prefix,
        prompt, duration: part.duration, onChild, threads: threadsPerWorker,
        detailPrefix: `切片 ${part.index + 1}/${part.count} · `,
        send(event) {
          progress.set(part.index, event.progress || 0);
          const overall = [...progress.values()].reduce((sum, value) => sum + value, 0) / parts.length;
          const elapsed = (Date.now() - started) / 1000;
          emit(send, {
            stage: 'transcribe', progress: overall,
            detail: `${workers} 路并行 · 已完成 ${Math.round(overall * 100)}%`,
            etaSeconds: overall > 0.01 ? elapsed / overall - elapsed : null
          });
        }
      });
      part.srt = outputs.srt;
      progress.set(part.index, 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, parts.length) }, worker));
  const result = mergePartSubtitles(parts, outputPrefix);
  try { fs.rmSync(partsDirectory, { recursive: true, force: true }); } catch { /* Temporary parts may be removed manually. */ }
  return result;
}

module.exports = {
  configureFfmpeg,
  MODELS,
  convertToWav,
  downloadFile,
  ensureModel,
  locateFfmpeg,
  mergePartSubtitles,
  probeDuration,
  runProcess,
  transcribe,
  transcribeSegmented
};
