const https = require('https');
const http = require('http');

function fetchPage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          if (redirectUrl.startsWith('/')) {
            const parsed = new URL(url);
            redirectUrl = parsed.origin + redirectUrl;
          }
          return fetchPage(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        }

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function normalizeUrl(rawUrl, sourceUrl) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith('//')) {
      const src = new URL(sourceUrl);
      return `${src.protocol}${trimmed}`;
    }
    return new URL(trimmed, sourceUrl).toString();
  } catch (_) {
    return null;
  }
}

function looksPlayable(url) {
  if (!url) return false;

  const lower = url.toLowerCase();
  if (!/^https?:\/\//.test(lower)) return false;

  if (/(\.css|\.js|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.webp|\.ico|\.woff2?|\.ttf)(\?|$)/.test(lower)) {
    return false;
  }

  if (/\/(ads?|analytics?|track|pixel)(\/|\?|$)/.test(lower)) {
    return false;
  }

  const allowedHints = [
    'videoembed',
    '.m3u8',
    '.mpd',
    '/live',
    '/embed',
    'player',
    'stream',
    'kanali',
    'playlist',
    'manifest',
    'watch',
    'youtu',
    'twitch.tv',
    'ok.ru',
    'dailymotion',
    'vimeo',
  ];

  return allowedHints.some((hint) => lower.includes(hint));
}

function scoreCandidate(url) {
  const lower = url.toLowerCase();
  let score = 0;

  if (lower.includes('videoembed')) score += 100;
  if (lower.includes('.m3u8')) score += 95;
  if (lower.includes('.mpd')) score += 90;
  if (lower.includes('/embed')) score += 80;
  if (lower.includes('/live')) score += 70;
  if (lower.includes('ok.ru')) score += 30;
  if (lower.endsWith('.php') || lower.includes('.php?')) score += 10;
  if (lower.includes('kanali-1')) score -= 60;

  return score;
}

function extractCandidateUrls(html, sourceUrl) {
  const urls = [];
  const seen = new Set();

  function push(raw) {
    const normalized = normalizeUrl(raw, sourceUrl);
    if (!normalized || !looksPlayable(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  }

  const patterns = [
    /(?:src|href|file|stream_url|video_url|embedUrl|url)\s*[:=]\s*["']([^"']+)["']/gi,
    /https?:\/\/[^\s"'<>\\]+/gi,
    /\/\/[a-z0-9.-]+\/[a-z0-9/_\-.?=&%]+/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      push(match[1] || match[0]);
    }
  }

  return urls;
}

exports.handler = async () => {
  const sourcePageUrl = 'https://bigbrothervipalbania.net/kanali-1';

  try {
    const sourceHtml = await fetchPage(sourcePageUrl);
    const urls = [];
    const seen = new Set();

    function addMany(list) {
      for (const item of list) {
        if (item && !seen.has(item)) {
          seen.add(item);
          urls.push(item);
        }
      }
    }

    addMany(extractCandidateUrls(sourceHtml, sourcePageUrl));

    const streamPageMatches = sourceHtml.match(/https?:\/\/[a-z0-9.-]+\/kanali1\.php[^"'\s<]*/gi) || [];
    addMany(streamPageMatches.map((u) => normalizeUrl(u, sourcePageUrl)).filter(Boolean));

    const pagesToProbe = [sourcePageUrl, ...streamPageMatches];

    for (const pageUrl of pagesToProbe) {
      try {
        const html = pageUrl === sourcePageUrl ? sourceHtml : await fetchPage(pageUrl);
        addMany(extractCandidateUrls(html, pageUrl));
      } catch (_) {
        // Ignore a single failing upstream page and keep best-effort results.
      }
    }

    const rankedUrls = urls
      .filter((url) => url !== sourcePageUrl && !url.startsWith(`${sourcePageUrl}/`))
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=120',
      },
      body: JSON.stringify({
        found: rankedUrls.length > 0,
        embedUrls: rankedUrls,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ found: false, error: err.message }),
    };
  }
};
