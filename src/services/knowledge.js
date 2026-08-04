const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureDirectory } = require('./utils');

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.srt', '.vtt']);
const INDEX_DIRECTORY = '.podcast-knowledge';
const INDEX_VERSION = 2;
const cache = new Map();

function walkTextFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === INDEX_DIRECTORY) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        && !/^(背景词表|校正记录|视频页面信息)/i.test(entry.name)) {
        const stat = fs.statSync(full);
        if (stat.size > 0 && stat.size <= 10 * 1024 * 1024) {
          files.push({
            full,
            relative: path.relative(root, full),
            size: stat.size,
            modified: stat.mtimeMs
          });
        }
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN'));
}

function fileSignature(files) {
  const value = files.map((file) => `${file.relative}\0${file.size}\0${file.modified}`).join('\n');
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTranscript(text, extension) {
  let value = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (extension === '.srt' || extension === '.vtt') {
    const blocks = value.replace(/^WEBVTT.*$/gmi, '').trim().split(/\n{2,}/);
    value = blocks.map((block) => {
      const lines = block.split('\n');
      if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
      const timing = lines.shift()?.match(/^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->/);
      const body = lines.join(' ').replace(/<[^>]+>/g, '').trim();
      return timing && body ? `[${timing[1]}] ${body}` : body;
    }).filter(Boolean).join('\n');
  }
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

function timestampFromText(text, last = false) {
  const matches = [...String(text || '').matchAll(/\[(\d{2}:\d{2}:\d{2}[,.]\d{3})\]/g)];
  return matches.length ? matches[last ? matches.length - 1 : 0][1].replace('.', ',') : '';
}

function metadataForFile(filePath) {
  const metadataPath = path.join(path.dirname(filePath), 'metadata.json');
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return {
      show: String(metadata.show || ''), episode: String(metadata.episode?.title || ''),
      author: String(metadata.author || ''), published: String(metadata.episode?.published || ''),
      platform: String(metadata.source_platform || '')
    };
  } catch { return { show: '', episode: '', author: '', published: '', platform: '' }; }
}

function evidenceTier(fileName) {
  if (/纪要|总结/i.test(fileName)) return 'navigation';
  if (/发布者|校正版|原始字幕|逐字稿|转录稿/i.test(fileName)) return 'primary';
  return 'supplemental';
}

function chunkText(text, maxChars = 2600, overlapChars = 260) {
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('\n\n', end),
        text.lastIndexOf('。', end),
        text.lastIndexOf('. ', end)
      );
      if (boundary > start + Math.floor(maxChars * 0.55)) end = boundary + 1;
    }
    const content = text.slice(start, end).trim();
    if (content) chunks.push(content);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

function tokenize(text) {
  const normalized = String(text || '').toLowerCase().normalize('NFKC');
  const tokens = [];
  for (const word of normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []) tokens.push(word);
  for (const sequence of normalized.match(/[\u3400-\u9fff]{1,}/g) || []) {
    if (sequence.length === 1) tokens.push(sequence);
    else for (let index = 0; index < sequence.length - 1; index += 1) tokens.push(sequence.slice(index, index + 2));
  }
  return tokens;
}

function indexPath(root) {
  return path.join(root, INDEX_DIRECTORY, 'index.json');
}

function readPersistedIndex(root, signature) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(root), 'utf8'));
    if (parsed.version === INDEX_VERSION && parsed.signature === signature && Array.isArray(parsed.chunks)) return parsed;
  } catch {
    // Rebuild missing or outdated indexes.
  }
  return null;
}

function buildKnowledgeIndex(root, force = false) {
  ensureDirectory(root);
  const files = walkTextFiles(root);
  const signature = fileSignature(files);
  const cached = cache.get(root);
  if (!force && cached?.signature === signature) return cached;
  if (!force) {
    const persisted = readPersistedIndex(root, signature);
    if (persisted) {
      cache.set(root, persisted);
      return persisted;
    }
  }

  const chunks = [];
  for (const file of files) {
    try {
      const extension = path.extname(file.full).toLowerCase();
      const content = normalizeTranscript(fs.readFileSync(file.full, 'utf8'), extension);
      const metadata = metadataForFile(file.full);
      chunkText(content).forEach((chunk, index) => {
        const timeStart = timestampFromText(chunk);
        const timeEnd = timestampFromText(chunk, true) || timeStart;
        const contextPrefix = [
          metadata.show ? `节目：${metadata.show}` : '',
          metadata.episode ? `单集：${metadata.episode}` : '',
          metadata.author ? `作者或嘉宾：${metadata.author}` : '',
          timeStart ? `时间：${timeStart}–${timeEnd}` : '',
          `文件：${file.relative}`
        ].filter(Boolean).join('；');
        chunks.push({
          id: `${file.relative}#${index + 1}`, source: file.relative, part: index + 1,
          content: chunk, contextPrefix, timeStart, timeEnd, metadata,
          evidenceTier: evidenceTier(path.basename(file.relative))
        });
      });
    } catch {
      // A single unreadable file must not block the whole knowledge base.
    }
  }
  const index = {
    version: INDEX_VERSION,
    signature,
    builtAt: new Date().toISOString(),
    fileCount: files.length,
    chunkCount: chunks.length,
    chunks
  };
  const directory = path.dirname(indexPath(root));
  ensureDirectory(directory);
  fs.writeFileSync(indexPath(root), JSON.stringify(index), 'utf8');
  cache.set(root, index);
  return index;
}

function bm25Ranks(index, query, limit = 50) {
  const queryTokens = [...new Set(tokenize(query))];
  if (!queryTokens.length) return [];
  const documents = index.chunks.map((chunk) => tokenize(`${chunk.contextPrefix || ''} ${chunk.content}`));
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map();
  for (const tokens of documents) for (const token of new Set(tokens)) {
    documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const normalizedQuery = String(query).toLowerCase().replace(/\s+/g, '');
  return index.chunks.map((chunk, indexValue) => {
    const tokens = documents[indexValue];
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const tf = frequencies.get(token) || 0;
      if (!tf) continue;
      const df = documentFrequency.get(token) || 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * tokens.length / Math.max(1, averageLength))));
    }
    if (`${chunk.contextPrefix}${chunk.content}`.toLowerCase().replace(/\s+/g, '').includes(normalizedQuery)) score += 8;
    if (chunk.evidenceTier === 'primary') score *= 1.08;
    if (chunk.evidenceTier === 'navigation') score *= 0.75;
    return { ...chunk, bm25Score: score };
  }).filter((item) => item.bm25Score > 0).sort((a, b) => b.bm25Score - a.bm25Score).slice(0, limit);
}

function searchKnowledge(root, request, limit = 30) {
  const index = buildKnowledgeIndex(root);
  const queries = typeof request === 'string' ? [request] : request.queries || [];
  if (!queries.length || !index.chunks.length) return { index, results: [], confidence: 0 };
  const fused = new Map();
  for (const query of queries) {
    bm25Ranks(index, query).forEach((item, rank) => {
      const current = fused.get(item.id) || { ...item, score: 0, matchedQueries: 0 };
      current.score += 1 / (60 + rank + 1);
      current.matchedQueries += 1;
      current.bm25Score = Math.max(current.bm25Score || 0, item.bm25Score);
      fused.set(item.id, current);
    });
  }
  const mode = typeof request === 'string' ? 'fact' : request.mode;
  const sorted = [...fused.values()].sort((a, b) => b.score - a.score || b.bm25Score - a.bm25Score);
  const results = [];
  const perSource = new Map();
  const sourceCap = ['comparison', 'cross_episode', 'global'].includes(mode) ? 3 : 8;
  for (const item of sorted) {
    const count = perSource.get(item.source) || 0;
    if (count >= sourceCap) continue;
    results.push(item);
    perSource.set(item.source, count + 1);
    if (results.length >= limit) break;
  }
  return { index, results, confidence: results.length ? Math.min(1, results[0].matchedQueries / Math.max(1, queries.length)) : 0 };
}

module.exports = { buildKnowledgeIndex, searchKnowledge, tokenize };
