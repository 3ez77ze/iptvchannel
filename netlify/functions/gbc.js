const https = require('https');

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
          'Accept-Language': 'en-GB,en;q=0.9',
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

exports.handler = async () => {
  const playerUrl = 'https://www.gbc.gi/tv/watch-live/player';

  try {
    const html = await fetchPage(playerUrl);

    // Look for .m3u8 URLs (with tokens/expiry params)
    const m3u8Match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (m3u8Match) {
      const streamUrl = m3u8Match[1]
        .replace(/&amp;/g, '&')
        .replace(/&#x2F;/g, '/')
        .replace(/&#47;/g, '/')
        .replace(/&quot;/g, '"');

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        },
        body: JSON.stringify({
          live: true,
          type: 'hls',
          url: streamUrl,
        }),
      };
    }

    // Look for Vimeo event embed (fallback)
    const vimeoMatch = html.match(
      /<iframe[^>]+src=["'](https?:\/\/(?:player\.)?vimeo\.com\/(?:event\/\d+\/embed[^"']*|video\/\d+[^"']*))["']/i
    );
    if (vimeoMatch) {
      const embedUrl = vimeoMatch[1].replace(/&amp;/g, '&');
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        },
        body: JSON.stringify({
          live: true,
          type: 'vimeo',
          url: embedUrl,
        }),
      };
    }

    // Look for any other iframe embed
    const iframeMatch = html.match(
      /<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i
    );
    if (iframeMatch) {
      const embedUrl = iframeMatch[1].replace(/&amp;/g, '&');
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        },
        body: JSON.stringify({
          live: true,
          type: 'iframe',
          url: embedUrl,
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
        live: false,
        message: 'No stream found on GBC player page',
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
        error: err.message,
      }),
    };
  }
};
