const { XMLParser } = require('fast-xml-parser');
const { cleanText, similarity } = require('./utils');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
  processEntities: true
});

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 PodcastTranscriber/0.1',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function fetchText(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { ...REQUEST_HEADERS, ...(options.headers || {}) },
      signal: options.signal
    });
  } catch (error) {
    const reason = error?.cause?.message || error?.cause?.code || error.message;
    throw new Error(`无法连接节目来源：${url}\n${reason}`);
  }
  if (!response.ok) throw new Error(`请求失败 (${response.status})：${url}`);
  return { text: await response.text(), response };
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return cleanText(match[1]);
  }
  return '';
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function nodeText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return cleanText(value);
  return cleanText(value['#text'] || value.text || value.value || '');
}

function normalizeFeed(parsed, feedUrl) {
  const channel = parsed?.rss?.channel || parsed?.feed;
  if (!channel) throw new Error('该地址不是可识别的播客 RSS/Atom Feed');
  const rawItems = asArray(channel.item || channel.entry);
  const items = rawItems.map((item) => {
    const enclosure = item.enclosure || {};
    const links = asArray(item.link);
    const enclosureLink = links.find((link) => link?.rel === 'enclosure') || {};
    const transcript = item['podcast:transcript'] || item.transcript;
    const transcriptItems = asArray(transcript).filter(Boolean);
    const mediaUrl = enclosure.url || enclosure.href || enclosureLink.href || '';
    const link = typeof item.link === 'string'
      ? item.link
      : links.find((entry) => !entry?.rel || entry.rel === 'alternate')?.href || '';
    return {
      title: nodeText(item.title),
      description: nodeText(item.description || item.summary || item['content:encoded'] || item.content),
      published: nodeText(item.pubDate || item.published || item.updated),
      guid: nodeText(item.guid || item.id),
      link,
      mediaUrl,
      mediaType: enclosure.type || enclosureLink.type || '',
      mediaBytes: Number(enclosure.length || 0) || null,
      duration: nodeText(item['itunes:duration'] || item.duration),
      transcripts: transcriptItems.map((entry) => ({
        url: typeof entry === 'string' ? entry : entry.url || entry.href || '',
        type: typeof entry === 'string' ? '' : entry.type || ''
      })).filter((entry) => entry.url)
    };
  });
  return {
    feedUrl,
    title: nodeText(channel.title),
    description: nodeText(channel.description || channel.subtitle),
    author: nodeText(channel['itunes:author'] || channel.author),
    link: typeof channel.link === 'string'
      ? channel.link
      : asArray(channel.link).find((entry) => !entry?.rel || entry.rel === 'alternate')?.href || '',
    items
  };
}

async function parseFeed(feedUrl, signal) {
  const { text, response } = await fetchText(feedUrl, { signal });
  const parsed = parser.parse(text);
  return normalizeFeed(parsed, response.url || feedUrl);
}

function bestEpisode(feed, target) {
  if (!feed.items.length) return null;
  if (!target?.title) return feed.items[0];
  const scored = feed.items.map((item) => {
    let score = similarity(item.title, target.title);
    if (target.releaseDate && item.published) {
      const delta = Math.abs(new Date(target.releaseDate) - new Date(item.published));
      if (Number.isFinite(delta)) {
        if (delta <= 36 * 3600 * 1000) score += 0.2;
        else if (delta <= 7 * 86400 * 1000) score += 0.06;
      }
    }
    return { item, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].score >= 0.45 ? { ...scored[0].item, matchConfidence: Math.min(1, scored[0].score) } : null;
}

async function appleLookup(showId, signal) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(showId)}&entity=podcastEpisode&limit=200`;
  const { text } = await fetchText(url, { signal, headers: { Accept: 'application/json' } });
  return JSON.parse(text).results || [];
}

async function itunesEpisodeSearch(term, signal) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcastEpisode&limit=50`;
  const { text } = await fetchText(url, { signal, headers: { Accept: 'application/json' } });
  return JSON.parse(text).results || [];
}

async function metadataForUrl(inputUrl, signal) {
  const url = new URL(inputUrl);
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    const videoId = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    if (!videoId) throw new Error('无法识别 YouTube 视频 ID');
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const { text } = await fetchText(oembedUrl, { signal, headers: { Accept: 'application/json' } });
    const data = JSON.parse(text);
    return { platform: 'YouTube', title: data.title, show: data.author_name, originalUrl: inputUrl };
  }

  if (host.endsWith('spotify.com')) {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(inputUrl)}`;
    try {
      const { text } = await fetchText(oembedUrl, { signal, headers: { Accept: 'application/json' } });
      const data = JSON.parse(text);
      return { platform: 'Spotify', title: cleanText(data.title), show: '', originalUrl: inputUrl };
    } catch {
      // Fall through to public page metadata.
    }
  }

  const { text: html } = await fetchText(inputUrl, { signal });
  const title = metaContent(html, 'og:title') || cleanText((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]);
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  const appleMatch = html.match(/https:\/\/podcasts\.apple\.com\/[^"'<>\\]+\/id(\d+)/i);
  return {
    platform: host.includes('xiaoyuzhou') ? '小宇宙' : '网页',
    title: title.replace(/\s*[-|｜]\s*(小宇宙|Spotify).*$/i, '').trim(),
    show: '',
    description,
    appleShowId: appleMatch?.[1] || null,
    originalUrl: inputUrl
  };
}

async function resolveApple(inputUrl, signal) {
  const url = new URL(inputUrl);
  const showId = (url.pathname.match(/id(\d+)/) || [])[1];
  if (!showId) throw new Error('Apple Podcasts 链接缺少节目 ID');
  const episodeId = url.searchParams.get('i');
  const results = await appleLookup(showId, signal);
  const show = results.find((item) => item.wrapperType === 'track' && item.kind !== 'podcast-episode') || results[0];
  const episode = episodeId
    ? results.find((item) => String(item.trackId) === String(episodeId))
    : results.find((item) => item.kind === 'podcast-episode');
  if (!show?.feedUrl) throw new Error('Apple 目录没有返回公开 RSS');
  const feed = await parseFeed(show.feedUrl, signal);
  const matched = bestEpisode(feed, {
    title: episode?.trackName,
    releaseDate: episode?.releaseDate
  });
  return buildResult('Apple Podcasts', feed, matched || feed.items[0], inputUrl);
}

function buildResult(platform, feed, episode, originalUrl) {
  if (!episode) throw new Error('RSS 中没有可用单集');
  return {
    platform,
    originalUrl,
    showTitle: feed.title,
    showAuthor: feed.author,
    feedUrl: feed.feedUrl,
    feedSite: feed.link,
    episode,
    canDownloadAudio: Boolean(episode.mediaUrl),
    hasPublisherTranscript: episode.transcripts.length > 0
  };
}

async function resolveByMetadata(inputUrl, signal) {
  const metadata = await metadataForUrl(inputUrl, signal);
  if (!metadata.title) throw new Error('无法从页面识别单集标题');

  let results = [];
  if (metadata.appleShowId) results = await appleLookup(metadata.appleShowId, signal);
  if (!results.length) results = await itunesEpisodeSearch(metadata.title, signal);

  const candidates = results
    .filter((item) => item.feedUrl && item.trackName)
    .map((item) => ({ item, score: similarity(item.trackName, metadata.title) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  for (const candidate of candidates) {
    if (candidate.score < 0.45) continue;
    try {
      const feed = await parseFeed(candidate.item.feedUrl, signal);
      const episode = bestEpisode(feed, {
        title: candidate.item.trackName || metadata.title,
        releaseDate: candidate.item.releaseDate
      });
      if (episode) return buildResult(metadata.platform, feed, episode, inputUrl);
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`已识别“${metadata.title}”，但没有找到可信的公开 RSS 单集匹配`);
}

async function resolvePodcast(input, signal) {
  const raw = String(input || '').trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error('请输入完整的 http 或 https 链接');
  const url = new URL(raw);
  if (url.hostname.includes('podcasts.apple.com')) return resolveApple(raw, signal);

  if (/\.(rss|xml)(\?|$)/i.test(url.pathname) || /feed|rss/i.test(url.pathname)) {
    try {
      const feed = await parseFeed(raw, signal);
      return buildResult('RSS', feed, feed.items[0], raw);
    } catch {
      // Continue with metadata discovery.
    }
  }

  return resolveByMetadata(raw, signal);
}

module.exports = { parseFeed, resolvePodcast };
