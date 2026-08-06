const { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolvePodcast } = require('./services/resolver');
const {
  answerKnowledgeQuestion,
  cleanSubtitleConstrained,
  cleanTranscript,
  createContext,
  expandKnowledgeQuery,
  extractEntityCandidates,
  rerankKnowledgePassages,
  summarizeTranscript,
  testApiKey
} = require('./services/deepseek');
const { buildKnowledgeIndex, searchKnowledge } = require('./services/knowledge');
const {
  convertToWav,
  configureFfmpeg,
  downloadFile,
  ensureModel,
  locateFfmpeg,
  probeDuration,
  transcribe,
  transcribeSegmented
} = require('./services/transcriber');
const { detectHardware, normalizeTranscriptionSettings } = require('./services/hardware');
const { downloadVideoAudio, downloadVideoSubtitle, inspectVideo, subtitleToTxt } = require('./services/video');
const { retryDescriptor } = require('./services/task-retry');
const { gatherFactEvidence } = require('./services/fact-check');
const { ensureDirectory, safeName, uniqueDirectory } = require('./services/utils');
const { PauseController } = require('./services/pause-controller');
const ffmpegStatic = require('ffmpeg-static');
const { createBinaryLocator } = require('./platform/binaries');
const { defaultOutputDirectory } = require('./platform/runtime');
const { configureLogger, getLogDirectory, logError } = require('./services/logger');
const { createSessionCredentialCache } = require('./services/credential-cache');

let mainWindow;
let activeTask = null;
const pendingTasks = [];
const taskHistory = new Map();
let taskSequence = 0;
let cachedHardwareProfile = null;
let binaryLocator = null;
const apiKeySessionCache = createSessionCredentialCache(process.platform);

function binaries() {
  if (!binaryLocator) binaryLocator = createBinaryLocator({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
    ffmpegFallback: ffmpegStatic
  });
  return binaryLocator;
}

function matchingEpisodeDirectory(outputRoot, resolved) {
  if (!fs.existsSync(outputRoot)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(outputRoot, entry.name);
    const metadataPath = path.join(directory, 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const sameGuid = resolved.episode.guid && metadata.episode?.guid === resolved.episode.guid;
      const sameMedia = resolved.episode.mediaUrl && metadata.episode?.mediaUrl === resolved.episode.mediaUrl;
      const sameSource = metadata.source_url === resolved.originalUrl;
      if (!sameGuid && !sameMedia && !sameSource) continue;
      const names = fs.readdirSync(directory);
      const score = (names.some((name) => /^发布者转录稿\.(txt|srt|vtt)$/i.test(name)) ? 30 : 0)
        + (names.some((name) => /^原始音频\.(mp3|m4a|mp4|aac|wav)$/i.test(name)) ? 20 : 0)
        + (names.includes('本地转录稿.txt') ? 5 : 0)
        + (names.includes('校正版转录稿.txt') ? 3 : 0);
      candidates.push({ directory, score, modified: fs.statSync(directory).mtimeMs });
    } catch {
      // Ignore damaged or unrelated folders.
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.modified - a.modified);
  return candidates[0]?.directory || null;
}

function firstExistingFile(directory, pattern) {
  if (!directory || !fs.existsSync(directory)) return null;
  const name = fs.readdirSync(directory).find((entry) => pattern.test(entry));
  return name ? path.join(directory, name) : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 680,
    backgroundColor: '#f5f1e8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettingsFile() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}

function decryptKey(settings = readSettingsFile()) {
  if (!settings.apiKeyEncrypted) return '';
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return apiKeySessionCache.decrypt(settings.apiKeyEncrypted, (encryptedValue) => (
      safeStorage.decryptString(Buffer.from(encryptedValue, 'base64'))
    ));
  } catch {
    return '';
  }
}

function publicSettings(settings = readSettingsFile()) {
  const profile = getHardwareProfile();
  return {
    outputDirectory: settings.outputDirectory || defaultOutputDirectory(app),
    model: settings.model || 'small',
    deepSeekEnabled: settings.deepSeekEnabled !== false,
    hasApiKey: Boolean(decryptKey(settings)),
    transcription: normalizeTranscriptionSettings(settings.transcription, profile)
  };
}

function writeSettings(input) {
  const current = readSettingsFile();
  const next = {
    ...current,
    outputDirectory: input.outputDirectory || current.outputDirectory || defaultOutputDirectory(app),
    model: ['small', 'medium', 'turbo'].includes(input.model) ? input.model : current.model || 'small',
    deepSeekEnabled: input.deepSeekEnabled !== false,
    transcription: normalizeTranscriptionSettings(input.transcription || current.transcription, getHardwareProfile())
  };
  if (input.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用安全凭据存储，API Key 未保存');
    next.apiKeyEncrypted = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
    apiKeySessionCache.remember(next.apiKeyEncrypted, input.apiKey.trim());
  }
  ensureDirectory(path.dirname(settingsPath()));
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return publicSettings(next);
}

function sendProgress(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:progress', value);
}

function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    stage: task.stage || 'queued',
    progress: task.progress || 0,
    detail: task.detail || '',
    etaSeconds: task.etaSeconds ?? null,
    result: task.result || null,
    error: task.error || null,
    logPath: task.logPath || null,
    queuedAt: task.queuedAt,
    retryOf: task.retryOf || null,
    attempt: task.attempt || 1
  };
}

function sendTaskUpdate(task) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task:update', publicTask(task));
  }
}

function enqueueTask(type, payload, title, metadata = {}) {
  const task = {
    id: `task-${Date.now()}-${++taskSequence}`,
    type,
    payload,
    title,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    detail: '等待前面的任务完成',
    queuedAt: Date.now(),
    retryOf: metadata.retryOf || null,
    attempt: metadata.attempt || 1
  };
  pendingTasks.push(task);
  taskHistory.set(task.id, task);
  sendTaskUpdate(task);
  processTaskQueue();
  return publicTask(task);
}

function updateQueuedTask(task, event) {
  task.stage = event.stage;
  task.progress = event.progress;
  task.detail = event.detail;
  task.etaSeconds = event.etaSeconds ?? null;
  sendProgress({ taskId: task.id, ...event });
  sendTaskUpdate(task);
}

function locateWhisperExecutable() {
  return binaries().whisper();
}

function locateWhisperRoot() {
  return binaries().whisperRoot();
}

function getHardwareProfile(refresh = false) {
  if (!cachedHardwareProfile || refresh) cachedHardwareProfile = detectHardware(locateWhisperRoot());
  return cachedHardwareProfile;
}

async function transcribeAudio({ modelPath, wavPath, outputPrefix, prompt, duration, progress, setChild, transcription, waitIfPaused }) {
  const common = {
    whisperExecutable: locateWhisperExecutable(), modelPath, wavPath, outputPrefix,
    prompt, duration, send: progress, onChild: setChild
  };
  const shouldSegment = transcription.segmentation
    && duration >= transcription.longAudioThresholdMinutes * 60;
  if (shouldSegment) {
    return transcribeSegmented({
      ...common,
      workers: transcription.workers,
      threadsPerWorker: transcription.threadsPerWorker,
      chunkMinutes: transcription.chunkMinutes,
      overlapSeconds: transcription.overlapSeconds,
      waitIfPaused
    });
  }
  return transcribe({ ...common, threads: transcription.threadsPerWorker * transcription.workers });
}

function locateBundledModelsDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(app.getAppPath(), 'vendor', 'models');
}

function locateYtDlpExecutable() {
  return binaries().ytDlp();
}

async function resolveInput(url, signal) {
  try {
    return await resolvePodcast(url, signal);
  } catch (rssError) {
    try {
      return await inspectVideo(url, locateYtDlpExecutable(), signal);
    } catch (videoError) {
      throw new Error(`${rssError.message}\n视频兜底同样失败：${videoError.message}`);
    }
  }
}

function writeMetadata(directory, resolved) {
  const metadata = {
    source_url: resolved.originalUrl,
    source_platform: resolved.platform,
    show: resolved.showTitle,
    author: resolved.showAuthor,
    feed_url: resolved.feedUrl,
    episode: resolved.episode,
    resolved_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

async function executeTask(payload, runtime) {
  const { abortController } = runtime;
  const progress = (event) => updateQueuedTask(runtime.task, event);
  const setChild = (child) => { runtime.children.add(child); };
  const signal = abortController.signal;
  const waitIfPaused = runtime.waitIfPaused;
  const settings = readSettingsFile();
  const apiKey = payload.apiKey || decryptKey(settings);
  const outputRoot = payload.outputDirectory || publicSettings(settings).outputDirectory;
  const model = payload.model || publicSettings(settings).model;
  const transcription = normalizeTranscriptionSettings(
    payload.transcription || publicSettings(settings).transcription,
    getHardwareProfile()
  );

  try {
    progress({ stage: 'resolve', progress: 0, detail: '正在识别链接与查找公开 RSS…' });
    const resolved = payload.resolved || await resolveInput(payload.url, signal);
    await waitIfPaused('等待继续后处理节目资源');
    progress({ stage: 'resolve', progress: 1, detail: `已匹配：${resolved.showTitle} · ${resolved.episode.title}` });

    ensureDirectory(outputRoot);
    const reusableDirectory = matchingEpisodeDirectory(outputRoot, resolved);
    const episodeDirectory = reusableDirectory || uniqueDirectory(
      outputRoot, `${resolved.showTitle} - ${resolved.episode.title}`
    );
    ensureDirectory(episodeDirectory);
    writeMetadata(episodeDirectory, resolved);
    if (resolved.sourceKind === 'video' && resolved.videoInfo?.raw) {
      fs.writeFileSync(
        path.join(episodeDirectory, '视频页面信息.json'),
        JSON.stringify(resolved.videoInfo.raw, null, 2),
        'utf8'
      );
    }
    if (reusableDirectory) {
      progress({ stage: 'reuse', progress: 1, detail: '已找到本期已有文件，将跳过重复下载' });
    }

    let context = [
      `节目：${resolved.showTitle}`,
      resolved.showAuthor ? `作者或主持人：${resolved.showAuthor}` : '',
      `单集：${resolved.episode.title}`,
      resolved.episode.description ? `简介：${resolved.episode.description.slice(0, 1200)}` : ''
    ].filter(Boolean).join('\n');

    if (payload.deepSeekEnabled !== false) {
      progress({ stage: 'context', progress: 0.15, detail: '正在生成节目背景词表…' });
      context = await createContext(apiKey, resolved, signal);
      await waitIfPaused('等待继续后保存节目背景');
      fs.writeFileSync(path.join(episodeDirectory, '背景词表.txt'), `${context}\n`, 'utf8');
      progress({ stage: 'context', progress: 1, detail: '背景词表已生成' });
    }

    let transcriptPath;
    let rawSubtitlePath = null;
    if (resolved.sourceKind === 'video' && resolved.videoInfo?.subtitle) {
      transcriptPath = firstExistingFile(episodeDirectory, /^原始字幕(?:\.[^.]+)?\.(srt|vtt)$/i);
      if (transcriptPath) {
        progress({ stage: 'reuse', progress: 1, detail: `复用已有视频字幕：${path.basename(transcriptPath)}` });
      } else {
        transcriptPath = await downloadVideoSubtitle({
          executable: locateYtDlpExecutable(),
          ffmpeg: locateFfmpeg(),
          url: resolved.originalUrl,
          directory: episodeDirectory,
          subtitle: resolved.videoInfo.subtitle,
          send: progress,
          onChild: setChild
        });
        await waitIfPaused('等待继续后整理已下载字幕');
      }
      rawSubtitlePath = transcriptPath;
      const rawTextPath = path.join(episodeDirectory, '原始字幕.txt');
      subtitleToTxt(rawSubtitlePath, rawTextPath);
      transcriptPath = rawTextPath;
    } else if (resolved.sourceKind === 'video') {
      rawSubtitlePath = firstExistingFile(episodeDirectory, /^原始逐字稿\.srt$/i);
      transcriptPath = firstExistingFile(episodeDirectory, /^原始逐字稿\.txt$/i);
      if (rawSubtitlePath) {
        if (!transcriptPath) {
          transcriptPath = path.join(episodeDirectory, '原始逐字稿.txt');
          subtitleToTxt(rawSubtitlePath, transcriptPath);
        }
        progress({ stage: 'reuse', progress: 1, detail: '已复用本期原始逐字稿，跳过音频下载、转换和 Whisper 转录' });
      } else {
        const audioPath = await downloadVideoAudio({
          executable: locateYtDlpExecutable(),
          ffmpeg: locateFfmpeg(),
          url: resolved.originalUrl,
          directory: episodeDirectory,
          send: progress,
          onChild: setChild
        });
        await waitIfPaused('等待继续后转换视频音频');
        const duration = await probeDuration(audioPath);
        const wavPath = path.join(episodeDirectory, '转录音频.wav');
        await convertToWav(audioPath, wavPath, duration, progress, setChild);
        await waitIfPaused('等待继续后开始本地转录');
        const modelPath = await ensureModel(
          model, app.getPath('userData'), progress, signal, locateBundledModelsDirectory()
        );
        const outputPrefix = path.join(episodeDirectory, '原始逐字稿');
        const outputs = await transcribeAudio({
          modelPath, wavPath, outputPrefix, prompt: context, duration,
          progress, setChild, transcription, waitIfPaused
        });
        transcriptPath = outputs.txt;
        rawSubtitlePath = outputs.srt;
        try { fs.unlinkSync(wavPath); } catch { /* Keep task result even if cleanup fails. */ }
      }
    } else if (resolved.episode.transcripts?.length) {
      transcriptPath = firstExistingFile(episodeDirectory, /^发布者转录稿\.(txt|srt|vtt)$/i);
      if (transcriptPath) {
        progress({ stage: 'reuse', progress: 1, detail: `复用已有字幕：${path.basename(transcriptPath)}` });
      } else {
        const transcript = resolved.episode.transcripts.find((item) => /text|plain|vtt|srt/i.test(item.type))
          || resolved.episode.transcripts[0];
        const extension = /vtt/i.test(transcript.type) ? '.vtt' : /srt/i.test(transcript.type) ? '.srt' : '.txt';
        transcriptPath = path.join(episodeDirectory, `发布者转录稿${extension}`);
        await downloadFile(transcript.url, transcriptPath, progress, 'transcript-download', signal);
        await waitIfPaused('等待继续后处理发布者转录稿');
      }
    } else {
      if (!resolved.episode.mediaUrl) throw new Error('该单集没有公开音频，也没有发布者转录稿');
      let audioPath = firstExistingFile(episodeDirectory, /^原始音频\.(mp3|m4a|mp4|aac|wav)$/i);
      if (audioPath) {
        progress({ stage: 'reuse', progress: 1, detail: `复用已有音频：${path.basename(audioPath)}` });
      } else {
        const audioExtension = /mp4|m4a/i.test(resolved.episode.mediaType) ? '.m4a' : '.mp3';
        audioPath = path.join(episodeDirectory, `原始音频${audioExtension}`);
        await downloadFile(resolved.episode.mediaUrl, audioPath, progress, 'audio-download', signal);
      }
      await waitIfPaused('等待继续后转换播客音频');
      const duration = await probeDuration(audioPath);
      const wavPath = path.join(episodeDirectory, '转录音频.wav');
      await convertToWav(audioPath, wavPath, duration, progress, setChild);
      await waitIfPaused('等待继续后开始本地转录');
      const modelPath = await ensureModel(
        model,
        app.getPath('userData'),
        progress,
        signal,
        locateBundledModelsDirectory()
      );
      const outputPrefix = path.join(episodeDirectory, '本地转录稿');
      const outputs = await transcribeAudio({
        modelPath, wavPath, outputPrefix, prompt: context, duration,
        progress, setChild, transcription, waitIfPaused
      });
      transcriptPath = outputs.txt;
      try { fs.unlinkSync(wavPath); } catch { /* Keep task result even if cleanup fails. */ }
    }

    await waitIfPaused('等待继续后校正或输出转录结果');
    let finalTranscript = transcriptPath;
    let qualityWarnings = [];
    if (payload.deepSeekEnabled !== false) {
      if (resolved.sourceKind === 'video' && rawSubtitlePath && /\.srt$/i.test(rawSubtitlePath)) {
        let evidence = [];
        if (payload.onlineFactCheck) {
          progress({ stage: 'fact-check', progress: 0.05, detail: '正在提取需要核查的专有名词…' });
          const candidates = await extractEntityCandidates(apiKey, rawSubtitlePath, context, signal);
          evidence = await gatherFactEvidence(candidates, resolved.showTitle, signal, ({ completed, total }) => {
            progress({
              stage: 'fact-check', progress: total ? completed / total : 1,
              detail: `联网核查专有名词 ${completed}/${total}`
            });
          });
        }
        const outputs = {
          srt: path.join(episodeDirectory, '校正版逐字稿.srt'),
          txt: path.join(episodeDirectory, '校正版逐字稿.txt'),
          audit: path.join(episodeDirectory, '校正记录.json')
        };
        const cleanResult = await cleanSubtitleConstrained(
          apiKey, rawSubtitlePath, outputs, context, evidence,
          ({ completed, total }) => progress({
            stage: 'clean', progress: completed / total,
            detail: `受约束字幕校正 ${completed}/${total}`
          }),
          signal,
          waitIfPaused
        );
        qualityWarnings = cleanResult.warnings || [];
        finalTranscript = outputs.txt;
      } else {
        const cleanedPath = path.join(episodeDirectory, '校正版转录稿.txt');
        await cleanTranscript(apiKey, transcriptPath, cleanedPath, context, ({ completed, total }) => {
          progress({
            stage: 'clean',
            progress: completed / total,
            detail: `校正文本 ${completed}/${total}`
          });
        }, signal, waitIfPaused);
        finalTranscript = cleanedPath;
      }
    }

    let summaryPath = null;
    if (payload.generateSummary) {
      if (!apiKey) throw new Error('生成学习纪要需要先保存 DeepSeek API Key');
      summaryPath = path.join(episodeDirectory, '学习纪要.md');
      progress({ stage: 'summary', progress: 0.2, detail: '正在生成证据可追溯的学习纪要…' });
      await summarizeTranscript(apiKey, finalTranscript, summaryPath, resolved, signal, (state) => {
        const fraction = state.phase === 'map'
          ? 0.15 + 0.65 * state.completed / Math.max(1, state.total)
          : 0.82 + 0.17 * state.completed / Math.max(1, state.total);
        progress({
          stage: 'summary', progress: fraction,
          detail: state.phase === 'map'
            ? `提取并验证逐字稿片段 ${state.completed}/${state.total}`
            : '正在合并全局学习纪要…'
        });
      }, waitIfPaused);
      progress({ stage: 'summary', progress: 1, detail: '结构化学习纪要已生成' });
    }

    await waitIfPaused('等待继续后完成并保存任务结果');
    const result = { outputDirectory: episodeDirectory, transcriptPath: finalTranscript, summaryPath, resolved, qualityWarnings };
    progress({
      stage: 'done', progress: 1,
      detail: qualityWarnings.length
        ? `处理完成；${qualityWarnings.length} 个校正批次因模型结构异常保留了原文，详情见校正记录`
        : '处理完成',
      result
    });
    return result;
  } catch (error) {
    if (signal.aborted) throw new Error('任务已取消');
    progress({ stage: 'error', progress: 0, detail: error.message });
    throw error;
  }
}

async function executeSummaryTask(payload, runtime) {
  const settings = readSettingsFile();
  const apiKey = decryptKey(settings);
  if (!apiKey) throw new Error('生成学习纪要需要先保存 DeepSeek API Key');
  const progress = (event) => updateQueuedTask(runtime.task, event);
  const summaryPath = path.join(payload.outputDirectory, '学习纪要.md');
  progress({ stage: 'summary', progress: 0.1, detail: '正在分段提取、验证并合并学习纪要…' });
  await summarizeTranscript(
    apiKey,
    payload.transcriptPath,
    summaryPath,
    payload.resolved,
    runtime.abortController.signal,
    (state) => progress({
      stage: 'summary',
      progress: state.phase === 'map'
        ? 0.1 + 0.7 * state.completed / Math.max(1, state.total)
        : 0.82 + 0.17 * state.completed / Math.max(1, state.total),
      detail: state.phase === 'map'
        ? `提取并验证逐字稿片段 ${state.completed}/${state.total}`
        : '正在合并全局学习纪要…'
    }),
    runtime.waitIfPaused
  );
  await runtime.waitIfPaused('等待继续后完成学习纪要任务');
  const result = { ...payload, summaryPath };
  progress({ stage: 'done', progress: 1, detail: '结构化学习纪要已生成', result });
  return result;
}

async function processTaskQueue() {
  if (activeTask || !pendingTasks.length) return;
  const nextIndex = pendingTasks.findIndex((item) => item.status === 'queued');
  if (nextIndex < 0) return;
  const [task] = pendingTasks.splice(nextIndex, 1);
  const pauseController = new PauseController();
  const runtime = {
    task,
    abortController: new AbortController(),
    children: new Set(),
    pauseController
  };
  runtime.waitIfPaused = async (detail) => {
    await pauseController.checkpoint(
    () => {
      task.status = 'paused';
      task.detail = detail || '任务已安全暂停';
      task.etaSeconds = null;
      sendTaskUpdate(task);
    },
    () => {
      task.status = 'running';
      task.detail = '任务已继续';
      sendTaskUpdate(task);
    });
    if (runtime.abortController.signal.aborted) throw new Error('任务已取消');
  };
  activeTask = runtime;
  task.status = 'running';
  task.detail = task.type === 'summary' ? '正在生成结构化学习纪要' : '正在开始处理';
  sendTaskUpdate(task);
  try {
    task.result = task.type === 'summary'
      ? await executeSummaryTask(task.payload, runtime)
      : await executeTask(task.payload, runtime);
    task.status = 'completed';
    task.stage = 'done';
    task.progress = 1;
  } catch (error) {
    task.status = runtime.abortController.signal.aborted ? 'canceled' : 'failed';
    task.error = error.message;
    task.detail = error.message;
    if (task.status === 'failed') {
      task.logPath = logError('task', error, {
        taskId: task.id,
        taskType: task.type,
        title: task.title,
        stage: task.stage,
        attempt: task.attempt
      });
    }
  } finally {
    sendTaskUpdate(task);
    activeTask = null;
    setImmediate(processTaskQueue);
  }
}

function cancelQueuedTask(taskId) {
  if (activeTask?.task.id === taskId) {
    activeTask.pauseController.resume();
    activeTask.abortController.abort();
    for (const child of activeTask.children) child.kill();
    return true;
  }
  const index = pendingTasks.findIndex((task) => task.id === taskId);
  if (index < 0) return false;
  const [task] = pendingTasks.splice(index, 1);
  task.status = 'canceled';
  task.detail = '已从队列取消';
  sendTaskUpdate(task);
  return true;
}

function pauseQueuedTask(taskId) {
  if (activeTask?.task.id === taskId) {
    activeTask.pauseController.request();
    activeTask.task.status = 'pausing';
    activeTask.task.detail = '正在完成当前安全步骤，随后暂停';
    activeTask.task.etaSeconds = null;
    sendTaskUpdate(activeTask.task);
    return publicTask(activeTask.task);
  }
  const task = pendingTasks.find((item) => item.id === taskId);
  if (!task || task.status !== 'queued') return null;
  task.status = 'paused';
  task.detail = '任务已在队列中暂停';
  sendTaskUpdate(task);
  setImmediate(processTaskQueue);
  return publicTask(task);
}

function resumeQueuedTask(taskId) {
  if (activeTask?.task.id === taskId && ['pausing', 'paused'].includes(activeTask.task.status)) {
    activeTask.pauseController.resume();
    activeTask.task.status = 'running';
    activeTask.task.detail = '任务已继续';
    sendTaskUpdate(activeTask.task);
    return publicTask(activeTask.task);
  }
  const task = pendingTasks.find((item) => item.id === taskId);
  if (!task || task.status !== 'paused') return null;
  task.status = 'queued';
  task.detail = '等待调度继续处理';
  sendTaskUpdate(task);
  setImmediate(processTaskQueue);
  return publicTask(task);
}

function retryFailedTask(taskId) {
  const descriptor = retryDescriptor(taskHistory.get(taskId));
  return enqueueTask(descriptor.type, descriptor.payload, descriptor.title, descriptor);
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      logError(`ipc:${channel}`, error, { channel });
      throw error;
    }
  });
}

app.whenReady().then(() => {
  configureLogger(path.join(app.getPath('userData'), 'logs'));
  // Chromium's network stack follows the Windows proxy, certificate and DNS
  // configuration. Node's built-in fetch does not consistently do so.
  globalThis.fetch = (input, init) => net.fetch(input, init);
  configureFfmpeg(binaries().ffmpeg());
  registerIpcHandler('settings:get', () => publicSettings());
  registerIpcHandler('hardware:get', () => getHardwareProfile());
  registerIpcHandler('settings:save', (_event, settings) => writeSettings(settings));
  registerIpcHandler('deepseek:test', async (_event, apiKey) => testApiKey(apiKey || decryptKey()));
  registerIpcHandler('dialog:output-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  registerIpcHandler('podcast:inspect', async (_event, url) => resolveInput(url));
  registerIpcHandler('task:enqueue', (_event, payload) => enqueueTask(
    'transcription',
    payload,
    payload.resolved?.episode?.title || payload.url
  ));
  registerIpcHandler('task:enqueue-summary', (_event, sourceTaskId) => {
    const source = taskHistory.get(sourceTaskId);
    if (!source?.result?.transcriptPath) throw new Error('找不到可以生成纪要的转录结果');
    return enqueueTask(
      'summary',
      source.result,
      `生成学习纪要：${source.result.resolved.episode.title}`
    );
  });
  registerIpcHandler('task:list', () => [...taskHistory.values()].map(publicTask));
  registerIpcHandler('task:cancel', (_event, taskId) => cancelQueuedTask(taskId));
  registerIpcHandler('task:pause', (_event, taskId) => pauseQueuedTask(taskId));
  registerIpcHandler('task:resume', (_event, taskId) => resumeQueuedTask(taskId));
  registerIpcHandler('task:retry', (_event, taskId) => retryFailedTask(taskId));
  registerIpcHandler('knowledge:stats', () => {
    const root = publicSettings().outputDirectory;
    const index = buildKnowledgeIndex(root);
    return { root, fileCount: index.fileCount, chunkCount: index.chunkCount, builtAt: index.builtAt };
  });
  registerIpcHandler('knowledge:refresh', () => {
    const root = publicSettings().outputDirectory;
    const index = buildKnowledgeIndex(root, true);
    return { root, fileCount: index.fileCount, chunkCount: index.chunkCount, builtAt: index.builtAt };
  });
  registerIpcHandler('knowledge:ask', async (_event, question) => {
    const value = String(question || '').trim();
    if (!value) throw new Error('请输入要向知识库提出的问题');
    const settings = readSettingsFile();
    const apiKey = decryptKey(settings);
    if (!apiKey) throw new Error('知识库问答需要先保存 DeepSeek API Key');
    const root = publicSettings(settings).outputDirectory;
    const plan = await expandKnowledgeQuery(apiKey, value, undefined);
    const retrieval = searchKnowledge(root, plan, 30);
    if (!retrieval.results.length) {
      return {
        answer: '无法基于当前本地知识库回答这个问题。',
        sources: [],
        stats: { root, fileCount: retrieval.index.fileCount, chunkCount: retrieval.index.chunkCount }
      };
    }
    const reranked = await rerankKnowledgePassages(apiKey, value, retrieval.results, 10, undefined);
    if (!reranked.length) {
      return {
        answer: '无法基于当前本地知识库回答这个问题。', sources: [],
        stats: { root, fileCount: retrieval.index.fileCount, chunkCount: retrieval.index.chunkCount }
      };
    }
    const result = await answerKnowledgeQuestion(apiKey, value, reranked, undefined);
    return {
      ...result,
      stats: { root, fileCount: retrieval.index.fileCount, chunkCount: retrieval.index.chunkCount }
    };
  });
  registerIpcHandler('shell:open-path', (_event, target) => shell.openPath(target));
  registerIpcHandler('logs:open-directory', () => shell.openPath(getLogDirectory()));
  createWindow();
}).catch((error) => {
  const logPath = logError('startup', error);
  dialog.showErrorBox('播客转录助手启动失败', `${error.message}${logPath ? `\n\n错误日志：${logPath}` : ''}`);
  app.quit();
});

process.on('unhandledRejection', (error) => {
  logError('unhandled-rejection', error instanceof Error ? error : new Error(String(error)));
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
