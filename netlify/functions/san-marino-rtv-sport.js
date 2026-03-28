const https = require('https');

function fetchPage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }

    const mod = url.startsWith('https') ? https : require('http');

    const req = mod.get(
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

exports.handler = async () => {
  const scriptUrl =
    'https://catchup.acdsolutions.it/jstag/videoplayerLiveFluid/TV?ch=1&eID=livePlayerPageElement&vID=99999999999&autoPlay=true';

  try {
    const js = await fetchPage(scriptUrl);

    const match = js.match(
      /(https:\/\/smrtvlive\.b-cdn\.net\/[^\s"';]+\.m3u8)/
    );

    if (!match) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        },
        body: JSON.stringify({
          live: false,
          message: 'No stream URL found in San Marino RTV Sport player script',
        }),
      };
    }

    const streamUrl = match[1].replace(/&amp;/g, '&');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
      },
      body: JSON.stringify({
        live: true,
        url: streamUrl,
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
