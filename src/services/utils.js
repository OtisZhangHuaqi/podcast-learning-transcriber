const fs = require('fs');
const path = require('path');

function cleanText(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeName(value, fallback = 'podcast') {
  const name = cleanText(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return name || fallback;
}

function normalizeTitle(value = '') {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
    .replace(/part(?:\s*)\d+/g, '')
    .replace(/第[一二三四五六七八九十\d]+[期集部]/g, '');
}

function similarity(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const grams = (text) => {
    const out = new Set();
    for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
    return out;
  };
  const x = grams(left);
  const y = grams(right);
  const intersection = [...x].filter((item) => y.has(item)).length;
  return (2 * intersection) / Math.max(1, x.size + y.size);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function uniqueDirectory(parent, desiredName) {
  const base = path.join(parent, safeName(desiredName));
  if (!fs.existsSync(base)) return base;
  let index = 2;
  while (fs.existsSync(`${base} (${index})`)) index += 1;
  return `${base} (${index})`;
}

module.exports = {
  cleanText,
  ensureDirectory,
  formatSeconds,
  normalizeTitle,
  safeName,
  similarity,
  uniqueDirectory
};
