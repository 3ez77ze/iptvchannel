const https = require('https');

function decodeEntities(value) {
  if (!value) return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function fetchPage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }

    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          fetchPage(nextUrl, redirects + 1).then(resolve).catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          reject(new Error(`unexpected status ${status}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

function firstMatch(html, regex) {
  const match = html.match(regex);
  return match && match[1] ? decodeEntities(match[1].trim()) : '';
}

function getYoutubeId(url) {
  if (!url) return '';
  const cleaned = decodeEntities(url);
  const embedMatch = cleaned.match(/youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/i);
  if (embedMatch) return embedMatch[1];

  const watchMatch = cleaned.match(/[?&]v=([a-zA-Z0-9_-]{11})/i);
  if (watchMatch) return watchMatch[1];

  const shortMatch = cleaned.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
  if (shortMatch) return shortMatch[1];

  return '';
}

function extractLiveSource(html) {
  const hlsUrl =
    firstMatch(html, /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i) ||
    firstMatch(html, /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
  if (hlsUrl) {
    return { sourceType: 'hls', url: hlsUrl };
  }

  const dashUrl =
    firstMatch(html, /(https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*)/i) ||
    firstMatch(html, /["'](https?:\/\/[^"']+\.mpd[^"']*)["']/i);
  if (dashUrl) {
    return { sourceType: 'dash', url: dashUrl };
  }

  const iframeYoutube =
    firstMatch(html, /<iframe[^>]+src=["']([^"']*youtube(?:-nocookie)?\.com\/embed\/[^"']+)["']/i) ||
    firstMatch(html, /["'](https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[^"']+)["']/i);
  if (iframeYoutube) {
    const videoId = getYoutubeId(iframeYoutube);
    return {
      sourceType: 'youtube',
      url: iframeYoutube,
      youtubeVideoId: videoId,
    };
  }

  const watchYoutube =
    firstMatch(html, /["'](https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[^"']+)["']/i) ||
    firstMatch(html, /["'](https?:\/\/youtu\.be\/[^"']+)["']/i);
  if (watchYoutube) {
    const videoId = getYoutubeId(watchYoutube);
    return {
      sourceType: 'youtube',
      url: watchYoutube,
      youtubeVideoId: videoId,
    };
  }

  return null;
}

exports.handler = async () => {
  const pageUrl = 'https://www.comunicazione.va/it/servizi/live.html';
  try {
    const html = await fetchPage(pageUrl);
    const source = extractLiveSource(html);

    if (!source) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        },
        body: JSON.stringify({
          live: false,
          pageUrl,
          message: 'No live source found on Vatican live page',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
      },
      body: JSON.stringify({
        live: true,
        pageUrl,
        ...source,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        live: false,
        pageUrl,
        error: err.message,
      }),
    };
  }
};
