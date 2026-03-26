const https = require('https');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

exports.handler = async (event) => {
  const channelHandle = event.queryStringParameters?.channel || '@RadioTelevizioniShqiptar';
  const url = `https://www.youtube.com/${channelHandle}/streams`;

  try {
    const html = await fetchPage(url);

    // Look for live video IDs in the page data
    // YouTube marks live streams with {"style":"LIVE"} or "isLive":true or badges with "LIVE"
    const liveVideoIds = [];

    // Method 1: Find videoRenderer items with LIVE badge
    // The page contains JSON data with video information
    const videoIdMatches = html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
    const allVideoIds = [...new Set([...videoIdMatches].map(m => m[1]))];

    // Check for live indicators near video IDs
    // YouTube uses overlayStyle: "LIVE" or badge label "LIVE NOW" for currently streaming
    const livePattern = /("videoId":"([a-zA-Z0-9_-]{11})"[\s\S]*?"style":"LIVE")|("style":"LIVE"[\s\S]*?"videoId":"([a-zA-Z0-9_-]{11})")/g;
    let match;
    while ((match = livePattern.exec(html)) !== null) {
      const videoId = match[2] || match[4];
      if (videoId) liveVideoIds.push(videoId);
    }

    // Method 2: Look for thumbnailOverlays with LIVE style
    const liveOverlayPattern = /"videoId":"([a-zA-Z0-9_-]{11})"[^}]*?"thumbnailOverlays":\[.*?"style":"LIVE"/g;
    while ((match = liveOverlayPattern.exec(html)) !== null) {
      if (match[1] && !liveVideoIds.includes(match[1])) {
        liveVideoIds.push(match[1]);
      }
    }

    // Method 3: Search for live badge text patterns
    const liveBadgePattern = /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,3000}?"label":"LIVE"/g;
    while ((match = liveBadgePattern.exec(html)) !== null) {
      if (match[1] && !liveVideoIds.includes(match[1])) {
        liveVideoIds.push(match[1]);
      }
    }

    // Method 4: Look for {"text":"LIVE"} near video IDs (broader search)
    const broadLivePattern = /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,5000}?"text":"LIVE( NOW)?"/g;
    while ((match = broadLivePattern.exec(html)) !== null) {
      if (match[1] && !liveVideoIds.includes(match[1])) {
        liveVideoIds.push(match[1]);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
      },
      body: JSON.stringify({
        live: liveVideoIds.length > 0,
        videoIds: liveVideoIds,
        totalVideosFound: allVideoIds.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ live: false, error: err.message }),
    };
  }
};
