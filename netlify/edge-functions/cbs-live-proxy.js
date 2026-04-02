const CBS_ORIGIN = "https://www.cbsnews.com";
const LIVE_CHANNELS_ENDPOINT = `${CBS_ORIGIN}/video/xhr/collection/component/live-channels/`;
const BASE_PROXY_PATH = "/api/cbs-live-proxy";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

function isPrivateIpv4(hostname) {
  const normalized = (hostname || "").trim().toLowerCase();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return false;

  const parts = normalized.split(".").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedHost(hostname) {
  const value = (hostname || "").toLowerCase();
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value === "::1" ||
    value === "[::1]" ||
    isPrivateIpv4(value)
  );
}

function safeAbsoluteUrl(raw, base) {
  try {
    const absolute = new URL(raw, base);
    if (!["http:", "https:"].includes(absolute.protocol)) return "";
    if (isBlockedHost(absolute.hostname)) return "";
    return absolute.toString();
  } catch {
    return "";
  }
}

function parseChannelAlias(input) {
  const lowered = (input || "").trim().toLowerCase();
  if (!lowered) return "cbsnews";

  const aliases = {
    "24/7": "cbsnews",
    "247": "cbsnews",
    "24-7": "cbsnews",
    "cbs-news": "cbsnews",
    "cbs news": "cbsnews",
    "cbs news 24/7": "cbsnews",
    "new york": "newyork",
    "bay area": "sanfrancisco",
    "san francisco": "sanfrancisco",
    "los angeles": "losangeles",
  };

  if (aliases[lowered]) return aliases[lowered];

  try {
    const parsed = new URL(input);
    if (parsed.origin === CBS_ORIGIN) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts[0] === "live" && parts[1]) return parts[1].toLowerCase();
      if (parts[1] === "live" && parts[0]) return parts[0].toLowerCase();
    }
  } catch {
    // not a URL
  }

  return lowered
    .replace(/^cbs\s+news\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "cbsnews";
}

function normalizeCbsPage(raw) {
  if (!raw) return "";
  try {
    const parsed = new URL(raw, CBS_ORIGIN);
    if (parsed.origin !== CBS_ORIGIN) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractStreamFromPage(html) {
  if (!html) return "";

  const metaPatterns = [
    /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
  ];

  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].includes(".m3u8")) {
      return match[1];
    }
  }

  const candidates = html.match(/https?:\/\/[^"'<>\s]+/gi) || [];
  const fallback = candidates.find((candidate) => candidate.toLowerCase().includes(".m3u8"));
  return fallback || "";
}

function buildUpstreamHeaders(request, referer) {
  const headers = new Headers();

  const passthrough = [
    "accept",
    "accept-language",
    "if-none-match",
    "if-modified-since",
    "range",
  ];

  for (const name of passthrough) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (!headers.has("accept")) headers.set("accept", "*/*");
  headers.set("user-agent", "Mozilla/5.0 (compatible; NetlifyCbsLiveProxy/1.0)");

  const parsedReferer = normalizeCbsPage(referer) || `${CBS_ORIGIN}/`;
  const refererUrl = new URL(parsedReferer);
  headers.set("referer", refererUrl.toString());
  headers.set("origin", refererUrl.origin);

  return headers;
}

async function fetchLiveChannels(request) {
  const response = await fetch(LIVE_CHANNELS_ENDPOINT, {
    method: "GET",
    headers: buildUpstreamHeaders(request, `${CBS_ORIGIN}/`),
  });

  if (!response.ok) {
    throw new Error(`Live channels feed failed with ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
}

function pickChannel(channels, channelQuery) {
  const wanted = parseChannelAlias(channelQuery);
  const normalizedWanted = wanted.replace(/[^a-z0-9]/g, "");

  const scored = channels
    .map((entry) => {
      const live = entry?.items?.[0];
      if (!live) return null;

      const slug = (entry.slug || live.slug || "").toLowerCase();
      const title = (entry.title || live.title || "").toLowerCase();
      const liveUrl = (live.url || "").toLowerCase();
      const normalizedSlug = slug.replace(/[^a-z0-9]/g, "");
      const normalizedTitle = title.replace(/[^a-z0-9]/g, "");

      let score = 0;
      if (slug === wanted || normalizedSlug === normalizedWanted) score += 100;
      if (title.includes(wanted) || normalizedTitle.includes(normalizedWanted)) score += 40;
      if (liveUrl.includes(`/${wanted}/`) || liveUrl.includes(`/${normalizedWanted}/`)) score += 25;
      if (wanted === "cbsnews" && (slug === "cbsnews" || title.includes("24/7"))) score += 20;

      return { score, entry, live };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

async function resolveBootstrap(request, channelQuery, pageQuery) {
  const page = normalizeCbsPage(pageQuery);
  if (page) {
    const pageResponse = await fetch(page, {
      method: "GET",
      headers: buildUpstreamHeaders(request, page),
    });

    if (!pageResponse.ok) {
      throw new Error(`CBS live page failed with ${pageResponse.status}`);
    }

    const html = await pageResponse.text();
    const manifestUrl = safeAbsoluteUrl(extractStreamFromPage(html), page);
    if (!manifestUrl) {
      throw new Error("Could not extract a live stream URL from CBS page");
    }

    return {
      manifestUrl,
      referer: page,
      channelSlug: parseChannelAlias(channelQuery || page),
      page,
    };
  }

  const channels = await fetchLiveChannels(request);
  const picked = pickChannel(channels, channelQuery);

  if (!picked) {
    throw new Error("CBS channel not found");
  }

  const live = picked.live;
  const manifestCandidate =
    safeAbsoluteUrl(live.video2, CBS_ORIGIN) ||
    safeAbsoluteUrl(live.video, CBS_ORIGIN) ||
    safeAbsoluteUrl(live.previewUrl, CBS_ORIGIN);

  if (!manifestCandidate) {
    throw new Error("CBS channel does not expose a playable manifest");
  }

  return {
    manifestUrl: manifestCandidate,
    referer: normalizeCbsPage(live.url) || `${CBS_ORIGIN}/live/`,
    channelSlug: parseChannelAlias(picked.entry?.slug || live.slug || channelQuery),
    page: normalizeCbsPage(live.url),
  };
}

function rewriteManifest(body, baseUrl, state) {
  const lines = body.split("\n");

  const rewriteUrl = (raw) => {
    const absolute = safeAbsoluteUrl(raw, baseUrl);
    if (!absolute) return "";

    const params = new URLSearchParams({
      target: absolute,
    });

    if (state.referer) params.set("ref", state.referer);
    if (state.channel) params.set("channel", state.channel);
    if (state.page) params.set("page", state.page);

    return `${BASE_PROXY_PATH}?${params.toString()}`;
  };

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
          const proxied = rewriteUrl(uri);
          if (!proxied) return 'URI=""';
          return `URI="${proxied}"`;
        });
      }

      if (trimmed.startsWith("#")) return line;

      return rewriteUrl(trimmed);
    })
    .join("\n");
}

export default async (request) => {
  const cors = corsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target") || "";
  const referer = url.searchParams.get("ref") || "";
  const channel = url.searchParams.get("channel") || "";
  const page = url.searchParams.get("page") || "";

  try {
    let upstreamUrl = "";
    let upstreamReferer = referer;
    let stateChannel = parseChannelAlias(channel);
    let statePage = normalizeCbsPage(page);

    if (target) {
      upstreamUrl = safeAbsoluteUrl(target, CBS_ORIGIN);
      if (!upstreamUrl) {
        return new Response("Invalid CBS target", {
          status: 403,
          headers: cors,
        });
      }
    } else {
      const resolved = await resolveBootstrap(request, channel, page);
      upstreamUrl = resolved.manifestUrl;
      upstreamReferer = resolved.referer;
      stateChannel = resolved.channelSlug;
      statePage = resolved.page;
    }

    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: buildUpstreamHeaders(request, upstreamReferer),
      redirect: "follow",
    });

    const finalUrl = safeAbsoluteUrl(upstream.url || upstreamUrl, upstreamUrl) || upstreamUrl;
    const contentType = upstream.headers.get("content-type") || "";
    const isManifest =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      finalUrl.toLowerCase().includes(".m3u8");

    if (isManifest) {
      const manifest = await upstream.text();
      const rewritten = rewriteManifest(manifest, finalUrl, {
        referer: upstreamReferer,
        channel: stateChannel,
        page: statePage,
      });

      const headers = new Headers({
        ...cors,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      });

      return new Response(rewritten, {
        status: upstream.status,
        headers,
      });
    }

    const passthroughHeaders = new Headers({
      ...cors,
      "Content-Type": contentType || "application/octet-stream",
    });

    const copyHeaders = ["cache-control", "content-length", "accept-ranges", "content-range"];
    for (const headerName of copyHeaders) {
      const value = upstream.headers.get(headerName);
      if (value) passthroughHeaders.set(headerName, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error?.message || "Unknown CBS proxy error",
      }),
      {
        status: 502,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      }
    );
  }
};

export const config = {
  path: BASE_PROXY_PATH,
};
