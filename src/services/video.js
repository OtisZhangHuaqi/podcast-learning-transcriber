const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function runYtDlp(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    options.onChild?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      const value = data.toString('utf8');
      stdout += value;
      options.onOutput?.(value);
    });
    child.stderr.on('data', (data) => {
      const value = data.toString('utf8');
      stderr += value;
      options.onOutput?.(value);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`视频工具处理失败（错误码 ${code}）：${stderr.slice(-1200) || stdout.slice(-1200)}`));
    });
  });
}

function bestSubtitleLanguage(subtitles = {}, automaticCaptions = {}, preferredLanguage = '') {
  const preferredBase = String(preferredLanguage || '').split('-')[0];
  const priorities = [
    preferredLanguage ? new RegExp(`^${preferredLanguage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null,
    preferredBase ? new RegExp(`^${preferredBase}(?:-|$)`, 'i') : null,
    /^zh-hans$/i, /^zh-cn$/i, /^zh$/i, /^zh-/i,
    /^en$/i, /^en-us$/i, /^en-gb$/i, /^en-/i
  ].filter(Boolean);
  const choose = (collection) => {
    const keys = Object.keys(collection || {}).filter((key) => !/^live_chat$/i.test(key));
    for (const pattern of priorities) {
      const match = keys.find((key) => pattern.test(key));
      if (match) return match;
    }
    return keys[0] || null;
  };
  const publisher = choose(subtitles);
  if (publisher) return { language: publisher, automatic: false };
  const automatic = choose(automaticCaptions);
  return automatic ? { language: automatic, automatic: true } : null;
}

async function inspectVideo(url, executable, signal) {
  if (signal?.aborted) throw new Error('任务已取消');
  const result = await runYtDlp(executable, [
    '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--', url
  ]);
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw new Error('无法读取视频页面信息'); }
  const subtitle = bestSubtitleLanguage(info.subtitles, info.automatic_captions, info.language);
  return {
    sourceKind: 'video',
    platform: info.extractor_key || info.extractor || '在线视频',
    originalUrl: info.webpage_url || url,
    showTitle: info.channel || info.uploader || info.extractor_key || '视频播客',
    showAuthor: info.uploader || info.channel || '',
    feedUrl: '',
    canDownloadAudio: true,
    hasPublisherTranscript: Boolean(subtitle),
    videoInfo: {
      id: info.id,
      extractor: info.extractor,
      webpageUrl: info.webpage_url || url,
      thumbnail: info.thumbnail || '',
      subtitle,
      raw: info
    },
    episode: {
      title: info.title || `视频 ${info.id || ''}`,
      description: info.description || '',
      published: info.upload_date || info.timestamp || '',
      guid: `${info.extractor || 'video'}:${info.id || url}`,
      link: info.webpage_url || url,
      mediaUrl: '',
      mediaType: 'audio/video',
      mediaBytes: null,
      duration: info.duration || 0,
      transcripts: subtitle ? [{
        url: info.webpage_url || url,
        type: subtitle.automatic ? 'video/automatic-caption' : 'video/publisher-caption',
        language: subtitle.language
      }] : [],
      matchConfidence: 1
    }
  };
}

function findGenerated(directory, pattern) {
  if (!fs.existsSync(directory)) return null;
  const names = fs.readdirSync(directory).filter((name) => pattern.test(name));
  if (!names.length) return null;
  names.sort((a, b) => fs.statSync(path.join(directory, b)).mtimeMs - fs.statSync(path.join(directory, a)).mtimeMs);
  return path.join(directory, names[0]);
}

function subtitleToTxt(subtitlePath, outputPath) {
  const source = fs.readFileSync(subtitlePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const output = [];
  let timestamp = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^WEBVTT/i.test(line) || /^\d+$/.test(line) || /^NOTE\b/i.test(line)) continue;
    const match = line.match(/^(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+/);
    if (match) {
      timestamp = match[1].replace('.', ',');
      continue;
    }
    const text = line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (text) output.push(timestamp ? `[${timestamp}] ${text}` : text);
  }
  fs.writeFileSync(outputPath, `${output.join('\n')}\n`, 'utf8');
  return outputPath;
}

async function downloadVideoSubtitle({ executable, ffmpeg, url, directory, subtitle, send, onChild }) {
  const existing = findGenerated(directory, /^原始字幕(?:\.[^.]+)?\.(srt|vtt)$/i);
  if (existing) return existing;
  send({ stage: 'transcript-download', progress: 0.1, detail: `正在提取${subtitle.automatic ? '自动' : '发布者'}字幕…` });
  const args = [
    '--skip-download', '--no-playlist', '--no-warnings',
    subtitle.automatic ? '--write-auto-subs' : '--write-subs',
    '--sub-langs', subtitle.language,
    '--sub-format', 'srt/vtt/best', '--convert-subs', 'srt',
    '--ffmpeg-location', ffmpeg,
    '-o', path.join(directory, '原始字幕.%(ext)s'),
    '--', url
  ];
  await runYtDlp(executable, args, { onChild });
  const generated = findGenerated(directory, /^原始字幕(?:\.[^.]+)?\.(srt|vtt)$/i);
  if (!generated) throw new Error('视频页面显示存在字幕，但未能导出字幕文件');
  send({ stage: 'transcript-download', progress: 1, detail: `字幕已保存：${path.basename(generated)}` });
  return generated;
}

async function downloadVideoAudio({ executable, ffmpeg, url, directory, send, onChild }) {
  const existing = findGenerated(directory, /^原始音频\.(m4a|mp3|opus|webm|wav)$/i);
  if (existing) return existing;
  const started = Date.now();
  await runYtDlp(executable, [
    '--no-playlist', '--newline', '--no-warnings',
    '-x', '--audio-format', 'm4a', '--audio-quality', '0',
    '--ffmpeg-location', ffmpeg,
    '--progress-template', 'download:%(progress._percent_str)s|%(progress._eta_str)s',
    '-o', path.join(directory, '原始音频.%(ext)s'),
    '--', url
  ], {
    onChild,
    onOutput(value) {
      for (const line of value.split(/\r?\n/)) {
        const match = line.match(/download:\s*([\d.]+)%\|\s*(.*)/i);
        if (!match) continue;
        const progress = Math.min(1, Number(match[1]) / 100);
        const elapsed = (Date.now() - started) / 1000;
        send({
          stage: 'audio-download', progress,
          detail: `正在提取视频音频 ${Math.round(progress * 100)}%`,
          etaSeconds: progress > 0.01 ? elapsed / progress - elapsed : null
        });
      }
    }
  });
  const generated = findGenerated(directory, /^原始音频\.(m4a|mp3|opus|webm|wav)$/i);
  if (!generated) throw new Error('视频音频下载完成，但找不到输出文件');
  return generated;
}

module.exports = { downloadVideoAudio, downloadVideoSubtitle, inspectVideo, subtitleToTxt };
