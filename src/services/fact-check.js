const { cleanText } = require('./utils');

function decodeUrl(value) {
  try {
    const decoded = value.replace(/&amp;/g, '&');
    const url = new URL(decoded, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') || url.href;
  } catch { return value; }
}

async function searchWeb(query, signal) {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 PodcastTranscriber/0.1',
      Accept: 'text/html'
    },
    signal
  });
  if (!response.ok) throw new Error(`联网核查请求失败 (${response.status})`);
  const html = await response.text();
  const anchors = [...html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi)];
  return anchors.slice(0, 3).map((match, index) => ({
    query,
    title: cleanText(match[2]),
    url: decodeUrl(match[1]),
    snippet: cleanText(snippets[index]?.[1] || '')
  })).filter((item) => item.title && /^https?:\/\//i.test(item.url));
}

async function gatherFactEvidence(candidates, showTitle, signal, onProgress) {
  const evidence = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const query = `${candidate.searchQuery || candidate.heard} ${showTitle || ''}`.trim();
    try {
      evidence.push(...await searchWeb(query, signal));
    } catch {
      // Fact checking is best effort. The cleaner will retain uncertain text.
    }
    onProgress?.({ completed: index + 1, total: candidates.length });
  }
  const seen = new Set();
  return evidence.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 24);
}

module.exports = { gatherFactEvidence, searchWeb };
