const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  hardware: null,
  resolved: null,
  inspecting: false,
  tasks: new Map(),
  toastTimer: null
};

const stages = {
  queued: { label: '排队等待', overall: [0, 0] },
  resolve: { label: '识别节目', overall: [0, 0.1] },
  reuse: { label: '复用已有文件', overall: [0.1, 0.16] },
  context: { label: '理解节目背景', overall: [0.1, 0.16] },
  'transcript-download': { label: '下载发布者字幕', overall: [0.16, 0.55] },
  'audio-download': { label: '下载公开音频', overall: [0.16, 0.36] },
  convert: { label: '准备本地音频', overall: [0.36, 0.42] },
  model: { label: '准备本地识别模型', overall: [0.42, 0.54] },
  segment: { label: '切分长音频', overall: [0.54, 0.58] },
  transcribe: { label: '本地语音转录', overall: [0.58, 0.82] },
  'fact-check': { label: '联网核查专有名词', overall: [0.82, 0.88] },
  clean: { label: '校正转录文本', overall: [0.88, 0.95] },
  summary: { label: '生成结构化学习纪要', overall: [0.95, 0.99] },
  done: { label: '处理完成', overall: [1, 1] },
  error: { label: '处理失败', overall: [0, 0] }
};

const statusLabels = {
  queued: '队列中',
  running: '正在处理',
  pausing: '安全暂停中',
  paused: '已暂停',
  completed: '已完成',
  failed: '处理失败',
  canceled: '已取消'
};

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', isError);
  $('toast').classList.remove('hidden');
  state.toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4200);
}

function humanTime(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '正在估算剩余时间';
  const value = Math.max(0, Math.round(Number(seconds)));
  if (value < 60) return `预计还需 ${value} 秒`;
  if (value < 3600) return `预计还需 ${Math.ceil(value / 60)} 分钟`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.ceil((value % 3600) / 60);
  return `预计还需 ${hours} 小时 ${minutes} 分钟`;
}

function durationText(value) {
  if (!value) return '';
  if (/^\d+:\d+/.test(String(value))) return value;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}小时${m}分钟` : `${m}分钟`;
}

function updateStartState() {
  const factCheck = $('onlineFactCheck');
  factCheck.disabled = !$('deepSeekEnabled').checked;
  if (factCheck.disabled) factCheck.checked = false;
  const hasUrl = Boolean($('podcastUrl').value.trim());
  const needsKey = $('deepSeekEnabled').checked || $('generateSummary').checked;
  const keyReady = !needsKey || state.settings?.hasApiKey || $('apiKey').value.trim();
  $('startButton').disabled = state.inspecting || !hasUrl || !state.resolved || !keyReady;
}

function showSettings() {
  $('settingsOverlay').classList.remove('hidden');
  $('apiKey').value = '';
  $('apiKey').placeholder = state.settings?.hasApiKey ? '已安全保存；留空表示不修改' : '输入 DeepSeek API Key';
  $('outputDirectory').value = state.settings?.outputDirectory || '';
}

function hideSettings() { $('settingsOverlay').classList.add('hidden'); }

async function loadSettings() {
  const [settings, hardware] = await Promise.all([
    window.podcastApp.getSettings(), window.podcastApp.getHardwareProfile()
  ]);
  state.settings = settings;
  state.hardware = hardware;
  $('modelSelect').value = state.settings.model;
  $('deepSeekEnabled').checked = state.settings.deepSeekEnabled;
  $('outputDirectory').value = state.settings.outputDirectory;
  populatePerformanceControls(state.settings.transcription || hardware.recommended);
  updateStartState();
  if (!state.settings.hasApiKey) showSettings();
}

function replaceOptions(select, options, value) {
  select.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option');
    element.value = String(option.value);
    element.textContent = option.label;
    select.append(element);
  }
  select.value = String(value);
  if (!select.value && options.length) select.value = String(options[0].value);
}

function populateThreadOptions(value) {
  if (!state.hardware) return;
  const workers = Number($('workerSelect').value) || 1;
  const max = Math.max(2, Math.floor(state.hardware.limits.maxThreads / workers));
  const options = [];
  for (let threads = 2; threads <= max; threads += 1) {
    options.push({ value: threads, label: `${threads} 线程` });
  }
  replaceOptions($('threadSelect'), options, Math.min(Number(value) || 4, max));
}

function populatePerformanceControls(config) {
  const hardware = state.hardware;
  const backendOptions = [{ value: 'cpu', label: 'CPU（当前可用）' }];
  if (hardware.backends.metal) backendOptions.unshift({ value: 'metal', label: 'Apple Metal（推荐）' });
  if (hardware.backends.vulkan) backendOptions.push({ value: 'vulkan', label: 'Intel/AMD Vulkan GPU' });
  if (hardware.backends.cuda) backendOptions.push({ value: 'cuda', label: 'NVIDIA CUDA GPU' });
  replaceOptions($('backendSelect'), backendOptions, config.backend);
  replaceOptions(
    $('workerSelect'),
    Array.from({ length: hardware.limits.maxWorkers }, (_, index) => ({
      value: index + 1, label: index ? `${index + 1} 路并行` : '单进程'
    })),
    config.workers
  );
  populateThreadOptions(config.threadsPerWorker);
  replaceOptions(
    $('chunkSelect'),
    hardware.limits.chunkMinutes.map((minutes) => ({ value: minutes, label: `${minutes} 分钟` })),
    config.chunkMinutes
  );
  $('segmentationEnabled').checked = config.segmentation !== false;
  const gpuText = hardware.gpus.length ? hardware.gpus.map((gpu) => gpu.name).join('、') : '未检测到GPU';
  $('hardwareSummary').textContent = `${hardware.cpu.name} · ${hardware.cpu.logicalCpus}个逻辑线程 · ${hardware.memory.totalGb}GB内存 · ${gpuText}`;
  const recommended = hardware.recommended;
  const modelLabel = { small: 'Small', medium: 'Medium', turbo: 'Large v3 Turbo' }[recommended.model];
  const backendLabel = { metal: 'Apple Metal', cpu: 'CPU', vulkan: 'Vulkan', cuda: 'CUDA' }[recommended.backend];
  $('recommendationSummary').textContent = `本机推荐：${modelLabel}模型、${backendLabel}、${recommended.workers}路并行、每路${recommended.threadsPerWorker}线程、${recommended.chunkMinutes}分钟切片。`;
  refreshPerformanceImpact();
}

function currentTranscriptionSettings() {
  return {
    backend: $('backendSelect').value,
    segmentation: $('segmentationEnabled').checked,
    workers: Number($('workerSelect').value),
    threadsPerWorker: Number($('threadSelect').value),
    chunkMinutes: Number($('chunkSelect').value)
  };
}

function refreshPerformanceImpact() {
  if (!state.hardware) return;
  const config = currentTranscriptionSettings();
  const model = $('modelSelect').value;
  const notes = [];
  if (config.backend === 'metal') notes.push('<strong>计算后端：</strong>Apple Silicon 使用 Metal 加速，通常比纯 CPU 更快；高负载时仍会增加内存占用和温度。');
  if (model === 'small') notes.push('<strong>质量/速度：</strong>平衡，适合当前16GB内存。');
  if (model === 'medium') notes.push('<strong>方向：</strong>准确率通常更高，但明显更慢、内存占用更高。');
  if (model === 'turbo') notes.push('<strong>方向：</strong>质量更高，但模型大；集显共享内存下有卡顿和换页风险。');
  if (!config.segmentation) notes.push('<strong>长音频：</strong>上下文最连续，但只能单段推进，中英混合锁错语言和长时间失败重跑风险更高。');
  if (config.segmentation && config.workers === 2) notes.push('<strong>速度：</strong>两路并行通常更快；会增加内存、温度和切片边界校验成本。');
  if (config.chunkMinutes <= 10) notes.push('<strong>切片：</strong>调度更灵活，但上下文较短，专有名词和边界误差风险上升。');
  if (config.chunkMinutes >= 15) notes.push('<strong>切片：</strong>上下文更完整，但单片更慢，负载均衡较弱。');
  const totalThreads = config.workers * config.threadsPerWorker;
  notes.push(`<strong>CPU负载：</strong>${totalThreads}/${state.hardware.cpu.logicalCpus}个逻辑线程；数值越高通常越快，但发热、降频和界面卡顿风险越高。`);
  if (state.hardware.memory.freeGb < 3) notes.push(`<strong>当前风险：</strong>启动时仅剩${state.hardware.memory.freeGb}GB可用内存，建议关闭其他大型程序后再转录。`);
  $('performanceImpact').innerHTML = notes.join('<br>');
  const recommended = state.hardware.recommended;
  const isRecommended = model === recommended.model
    && config.backend === recommended.backend
    && config.segmentation === recommended.segmentation
    && config.workers === recommended.workers
    && config.threadsPerWorker === recommended.threadsPerWorker
    && config.chunkMinutes === recommended.chunkMinutes;
  $('profileBadge').textContent = isRecommended ? '推荐方案' : '自定义方案';
}

async function inspectLink() {
  const url = $('podcastUrl').value.trim();
  if (!url) return;
  state.inspecting = true;
  $('inspectButton').disabled = true;
  $('inspectButton').textContent = '识别中…';
  $('inputHint').textContent = '正在识别平台、反查公开 RSS 并匹配单集…';
  $('episodePreview').classList.add('hidden');
  state.resolved = null;
  updateStartState();
  try {
    const result = await window.podcastApp.inspectLink(url);
    state.resolved = result;
    $('previewPlatform').textContent = result.platform;
    $('previewShow').textContent = result.showTitle || '未知节目';
    $('previewTitle').textContent = result.episode.title;
    $('previewDate').textContent = result.episode.published ? new Date(result.episode.published).toLocaleDateString('zh-CN') : '';
    $('previewDuration').textContent = durationText(result.episode.duration);
    const isVideoFallback = result.sourceKind === 'video';
    $('previewSource').textContent = isVideoFallback ? '未找到 RSS · 已启用视频兜底' : (result.feedUrl ? '已找到公开 RSS' : '');
    const subtitle = result.videoInfo?.subtitle;
    $('previewTranscriptBadge').textContent = subtitle
      ? (subtitle.automatic ? '可提取平台自动字幕' : '可提取发布者字幕')
      : (result.hasPublisherTranscript ? '可直接提取字幕' : '需要本地转录');
    $('inputHint').textContent = isVideoFallback
      ? '识别完成：将优先提取视频字幕；没有字幕时才下载音频并本地转录。'
      : '识别完成。加入队列后可继续提交下一期节目。';
    $('episodePreview').classList.remove('hidden');
  } catch (error) {
    $('inputHint').textContent = error.message;
    showToast(error.message, true);
  } finally {
    state.inspecting = false;
    $('inspectButton').disabled = false;
    $('inspectButton').textContent = '识别节目';
    updateStartState();
  }
}

function overallProgress(task) {
  if (task.status === 'completed') return 1;
  if (task.status === 'queued') return 0;
  const config = stages[task.stage] || stages.resolve;
  const fraction = Math.max(0, Math.min(1, Number(task.progress) || 0));
  return config.overall[0] + (config.overall[1] - config.overall[0]) * fraction;
}

function actionButton(label, action, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `task-action${danger ? ' danger' : ''}`;
  button.textContent = label;
  button.dataset.action = action;
  return button;
}

function renderTasks() {
  const tasks = [...state.tasks.values()].sort((a, b) => b.queuedAt - a.queuedAt);
  $('taskSection').classList.toggle('hidden', tasks.length === 0);
  const outstanding = tasks.filter((task) => ['queued', 'running', 'pausing', 'paused'].includes(task.status)).length;
  $('queueCount').textContent = outstanding ? `${outstanding} 个待处理` : `${tasks.length} 个任务`;
  $('taskList').replaceChildren();

  for (const task of tasks) {
    const item = document.createElement('article');
    item.className = `task-item ${task.status}`;
    item.dataset.taskId = task.id;

    const top = document.createElement('div');
    top.className = 'task-item-top';
    const copy = document.createElement('div');
    copy.className = 'task-item-copy';
    const status = document.createElement('p');
    status.className = 'task-status';
    status.textContent = task.type === 'summary'
      ? `${statusLabels[task.status]} · 纪要任务`
      : statusLabels[task.status];
    const title = document.createElement('h3');
    title.className = 'task-title';
    title.textContent = task.title;
    const detail = document.createElement('p');
    detail.className = 'task-detail';
    detail.textContent = task.error || task.detail || stages[task.stage]?.label || '';
    copy.append(status, title, detail);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (['queued', 'running'].includes(task.status)) actions.append(actionButton('暂停', 'pause'));
    if (['pausing', 'paused'].includes(task.status)) actions.append(actionButton('继续', 'resume'));
    if (['queued', 'running', 'pausing', 'paused'].includes(task.status)) actions.append(actionButton('取消', 'cancel', true));
    if (task.status === 'failed') actions.append(actionButton('重试原任务', 'retry'));
    if (task.status === 'completed' && task.result?.outputDirectory) actions.append(actionButton('打开文件夹', 'open'));
    if (task.status === 'completed' && task.type === 'transcription' && !task.result?.summaryPath) {
      actions.append(actionButton('生成学习纪要', 'summary'));
    }
    top.append(copy, actions);
    item.append(top);

    if (['queued', 'running', 'pausing', 'paused'].includes(task.status)) {
      const overall = overallProgress(task);
      const track = document.createElement('div');
      track.className = 'progress-track';
      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      bar.style.width = `${Math.round(overall * 100)}%`;
      track.append(bar);
      const meta = document.createElement('div');
      meta.className = 'task-progress-meta';
      const percent = document.createElement('span');
      percent.textContent = task.status === 'queued' ? '等待中' : task.status === 'paused' ? '已暂停' : task.status === 'pausing' ? '暂停中' : `${Math.round(overall * 100)}%`;
      const eta = document.createElement('span');
      eta.textContent = task.status === 'queued' ? '将在前序任务完成后自动开始' : task.status === 'paused' ? '点击继续以恢复任务' : task.status === 'pausing' ? '当前安全步骤完成后暂停' : humanTime(task.etaSeconds);
      meta.append(percent, eta);
      item.append(track, meta);
    }
    $('taskList').append(item);
  }
}

function handleTaskUpdate(task) {
  state.tasks.set(task.id, task);
  renderTasks();
  if (task.status === 'completed') {
    const warnings = task.result?.qualityWarnings?.length || 0;
    showToast(warnings
      ? `转录任务已完成；${warnings} 个校正批次保留原文，详情见校正记录`
      : task.type === 'summary' ? '结构化学习纪要已经生成' : '转录任务已经完成', Boolean(warnings));
    loadKnowledgeStats().catch(() => {});
  }
  if (task.status === 'failed') showToast(task.error || '任务处理失败', true);
}

function showKnowledgeStats(stats) {
  $('knowledgeStats').textContent = `${stats.fileCount} 个文本文件 · ${stats.chunkCount} 个检索片段 · 目录：${stats.root}`;
  $('knowledgeStats').title = stats.root;
}

async function loadKnowledgeStats(force = false) {
  $('refreshKnowledgeButton').disabled = true;
  $('knowledgeStats').textContent = force ? '正在重新建立本地索引…' : '正在读取本地知识库…';
  try {
    const stats = force
      ? await window.podcastApp.refreshKnowledge()
      : await window.podcastApp.getKnowledgeStats();
    showKnowledgeStats(stats);
    return stats;
  } finally {
    $('refreshKnowledgeButton').disabled = false;
  }
}

async function askKnowledge() {
  const question = $('knowledgeQuestion').value.trim();
  if (!question) return;
  $('askKnowledgeButton').disabled = true;
  $('askKnowledgeButton').querySelector('span').textContent = '正在检索本地资料并回答…';
  $('knowledgeAnswer').classList.remove('hidden');
  $('knowledgeAnswerText').textContent = '正在检索所有已保存的播客文本…';
  $('knowledgeSources').classList.add('hidden');
  $('knowledgeSourceList').replaceChildren();
  try {
    const result = await window.podcastApp.askKnowledge(question);
    $('knowledgeAnswerText').textContent = result.answer;
    showKnowledgeStats(result.stats);
    if (result.sources?.length) {
      for (const source of result.sources) {
        const item = document.createElement('li');
        const time = source.timeStart ? ` · ${source.timeStart}–${source.timeEnd || source.timeStart}` : '';
        item.textContent = `[${source.id}] ${source.source}（片段 ${source.part}${time}）`;
        $('knowledgeSourceList').append(item);
      }
      $('knowledgeSources').classList.remove('hidden');
    }
  } catch (error) {
    $('knowledgeAnswerText').textContent = error.message;
    showToast(error.message, true);
  } finally {
    $('askKnowledgeButton').disabled = false;
    $('askKnowledgeButton').querySelector('span').textContent = '基于本地资料回答';
  }
}

async function enqueueCurrentTask() {
  if (!state.resolved) return;
  try {
    const task = await window.podcastApp.enqueueTask({
      url: $('podcastUrl').value.trim(),
      resolved: state.resolved,
      outputDirectory: state.settings.outputDirectory,
      model: $('modelSelect').value,
      deepSeekEnabled: $('deepSeekEnabled').checked,
      generateSummary: $('generateSummary').checked,
      onlineFactCheck: $('onlineFactCheck').checked,
      transcription: currentTranscriptionSettings()
    });
    state.tasks.set(task.id, task);
    renderTasks();
    showToast('已加入后台处理队列，可以继续提交下一期');
    $('podcastUrl').value = '';
    state.resolved = null;
    $('episodePreview').classList.add('hidden');
    $('inputHint').textContent = '任务已在后台排队。请继续粘贴下一期节目链接。';
    updateStartState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveSettings() {
  try {
    state.settings = await window.podcastApp.saveSettings({
      apiKey: $('apiKey').value.trim(),
      outputDirectory: $('outputDirectory').value,
      model: $('modelSelect').value,
      deepSeekEnabled: $('deepSeekEnabled').checked,
      transcription: currentTranscriptionSettings()
    });
    hideSettings();
    updateStartState();
    showToast('设置已安全保存');
  } catch (error) { showToast(error.message, true); }
}

$('settingsButton').addEventListener('click', showSettings);
$('closeSettingsButton').addEventListener('click', hideSettings);
$('settingsOverlay').addEventListener('click', (event) => { if (event.target === $('settingsOverlay')) hideSettings(); });
$('chooseDirectoryButton').addEventListener('click', async () => {
  const directory = await window.podcastApp.chooseOutputDirectory();
  if (directory) $('outputDirectory').value = directory;
});
$('testKeyButton').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  $('testKeyButton').disabled = true;
  $('keyStatus').textContent = '正在测试连接…';
  try {
    const result = await window.podcastApp.testDeepSeek(key);
    $('keyStatus').textContent = result.ok ? '连接成功，可以使用 DeepSeek。' : `服务返回：${result.message}`;
  } catch (error) {
    $('keyStatus').textContent = error.message;
    showToast(error.message, true);
  } finally { $('testKeyButton').disabled = false; }
});
$('saveSettingsButton').addEventListener('click', saveSettings);
$('inspectButton').addEventListener('click', inspectLink);
$('podcastUrl').addEventListener('input', () => {
  state.resolved = null;
  $('episodePreview').classList.add('hidden');
  updateStartState();
});
$('podcastUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') inspectLink(); });
$('deepSeekEnabled').addEventListener('change', updateStartState);
$('onlineFactCheck').addEventListener('change', updateStartState);
$('generateSummary').addEventListener('change', updateStartState);
$('modelSelect').addEventListener('change', () => {
  if (state.settings) state.settings.model = $('modelSelect').value;
  refreshPerformanceImpact();
});
for (const id of ['backendSelect', 'threadSelect', 'chunkSelect', 'segmentationEnabled']) {
  $(id).addEventListener('change', refreshPerformanceImpact);
}
$('workerSelect').addEventListener('change', () => {
  populateThreadOptions($('threadSelect').value);
  refreshPerformanceImpact();
});
$('resetPerformanceButton').addEventListener('click', () => {
  $('modelSelect').value = state.hardware.recommended.model;
  populatePerformanceControls(state.hardware.recommended);
});
$('startButton').addEventListener('click', enqueueCurrentTask);
$('refreshKnowledgeButton').addEventListener('click', () => loadKnowledgeStats(true).catch((error) => showToast(error.message, true)));
$('askKnowledgeButton').addEventListener('click', askKnowledge);
$('knowledgeQuestion').addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') askKnowledge();
});
$('taskList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  const item = event.target.closest('[data-task-id]');
  if (!button || !item) return;
  const task = state.tasks.get(item.dataset.taskId);
  try {
    if (button.dataset.action === 'cancel') await window.podcastApp.cancelTask(task.id);
    if (button.dataset.action === 'pause') await window.podcastApp.pauseTask(task.id);
    if (button.dataset.action === 'resume') await window.podcastApp.resumeTask(task.id);
    if (button.dataset.action === 'retry') {
      const retryTask = await window.podcastApp.retryTask(task.id);
      state.tasks.set(retryTask.id, retryTask);
      renderTasks();
      showToast(`已按原链接和设置加入重试队列（第 ${retryTask.attempt} 次）`);
    }
    if (button.dataset.action === 'open') await window.podcastApp.openPath(task.result.outputDirectory);
    if (button.dataset.action === 'summary') {
      const summaryTask = await window.podcastApp.enqueueSummary(task.id);
      state.tasks.set(summaryTask.id, summaryTask);
      renderTasks();
      showToast('学习纪要任务已加入队列');
    }
  } catch (error) { showToast(error.message, true); }
});

window.podcastApp.onTaskUpdate(handleTaskUpdate);
Promise.all([loadSettings(), window.podcastApp.listTasks(), loadKnowledgeStats()])
  .then(([, tasks]) => {
    for (const task of tasks) state.tasks.set(task.id, task);
    renderTasks();
  })
  .catch((error) => showToast(error.message, true));
