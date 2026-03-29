const KORYO_ORIGIN = "https://koryo.tv";
const KORYO_REFERER = "https://koryo.tv/channel/kctv";
const BASE_PROXY_PATH = "/api/kctv-proxy";
const DEFAULT_SESSION_TTL_SECONDS = 30;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

function buildKoryoHeaders({ sid, acceptJson = false } = {}) {
  const headers = new Headers({
    Accept: acceptJson ? "application/json" : "*/*",
    Origin: KORYO_ORIGIN,
    Referer: KORYO_REFERER,
    "User-Agent": "Mozilla/5.0 (compatible; NetlifyKctvProxy/1.0)",
  });

  if (sid) {
    headers.set("Cookie", `koryo_sid=${sid}`);
  }

  return headers;
}

function getSessionIdFromSetCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  const match = setCookieHeader.match(/(?:^|\s|,)koryo_sid=([^;]+)/i);
  return match?.[1] || "";
}

function randomHex(length = 12) {
  const source = crypto.randomUUID().replace(/-/g, "");
  return source.slice(0, Math.max(1, Math.min(length, source.length)));
}

function normalizeKoryoPath(raw, basePath) {
  try {
    const abs = new URL(raw, `${KORYO_ORIGIN}${basePath}`);
    if (abs.origin !== KORYO_ORIGIN) return "";
    return `${abs.pathname}${abs.search}`;
  } catch {
    return "";
  }
}

function isAllowedKoryoTarget(pathAndQuery) {
  return /^\/hls\/1080p\/pl\/[a-f0-9]{16,64}(?:\/|\.m3u8|\?|$)/i.test(pathAndQuery);
}

function extractPlaylistId(pathAndQuery) {
  const match = pathAndQuery.match(/\/pl\/([a-f0-9]{16,64})(?:\/|\.m3u8|\?|$)/i);
  return match?.[1] || "";
}

function rewriteManifest(body, basePath, sid, expiryTs) {
  const lines = body.split("\n");
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        const target = normalizeKoryoPath(uri, basePath);
        if (!target || !isAllowedKoryoTarget(target)) {
          return 'URI=""';
        }
        return `URI="${BASE_PROXY_PATH}?target=${encodeURIComponent(target)}&sid=${encodeURIComponent(sid)}&exp=${expiryTs}"`;
      });
    }

    if (trimmed.startsWith("#")) return line;

    const target = normalizeKoryoPath(trimmed, basePath);
    if (!target || !isAllowedKoryoTarget(target)) {
      return "";
    }

    return `${BASE_PROXY_PATH}?target=${encodeURIComponent(target)}&sid=${encodeURIComponent(sid)}&exp=${expiryTs}`;
  });

  return rewritten.join("\n");
}

async function refreshSession(sid, playlistId) {
  if (!sid || !playlistId) return;

  const params = new URLSearchParams({ playlistId });
  await fetch(`${KORYO_ORIGIN}/session/refresh?${params.toString()}`, {
    method: "GET",
    headers: buildKoryoHeaders({ sid, acceptJson: true }),
  }).catch(() => {});
}

function validateSid(sid) {
  return /^[a-z0-9]{16,128}$/i.test(sid);
}

function validateExp(expRaw) {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return false;
  const now = Date.now();
  return exp > now - 5_000 && exp < now + 5 * 60_000;
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
  const target = url.searchParams.get("target");
  const sid = url.searchParams.get("sid") || "";
  const expRaw = url.searchParams.get("exp") || "";

  try {
    // Bootstrap request: create fresh Koryo anon session and resolve active playlist.
    if (!target) {
      const anonResp = await fetch(`${KORYO_ORIGIN}/session/anon?quality=1080p`, {
        method: "GET",
        headers: buildKoryoHeaders({ acceptJson: true }),
      });

      if (!anonResp.ok) {
        return new Response("Failed to create KCTV session", {
          status: 502,
          headers: cors,
        });
      }

      const anonData = await anonResp.json().catch(() => ({}));
      const setCookie = anonResp.headers.get("set-cookie") || "";
      const resolvedSid = getSessionIdFromSetCookie(setCookie);
      const expiresIn = Number(anonData?.expiresIn) || DEFAULT_SESSION_TTL_SECONDS;

      if (!validateSid(resolvedSid)) {
        return new Response("Missing KCTV session", {
          status: 502,
          headers: cors,
        });
      }

      const bootstrapPath = `/kctv/live/${randomHex(12)}.m3u8`;
      const liveResp = await fetch(`${KORYO_ORIGIN}${bootstrapPath}`, {
        method: "GET",
        redirect: "manual",
        headers: buildKoryoHeaders({ sid: resolvedSid }),
      });

      const locationHeader = liveResp.headers.get("location") || "";
      const playlistPath = locationHeader
        ? normalizeKoryoPath(locationHeader, bootstrapPath)
        : normalizeKoryoPath(liveResp.url, bootstrapPath);

      if (!playlistPath || !isAllowedKoryoTarget(playlistPath)) {
        return new Response("Failed to resolve KCTV playlist", {
          status: 502,
          headers: cors,
        });
      }

      const playlistResp = await fetch(`${KORYO_ORIGIN}${playlistPath}`, {
        method: "GET",
        headers: buildKoryoHeaders({ sid: resolvedSid }),
      });

      if (!playlistResp.ok) {
        return new Response("Failed to load KCTV playlist", {
          status: 502,
          headers: cors,
        });
      }

      const manifest = await playlistResp.text();
      const expiryTs = Date.now() + Math.max(5, expiresIn) * 1_000;
      const rewritten = rewriteManifest(manifest, playlistPath, resolvedSid, expiryTs);

      return new Response(rewritten, {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }

    if (!validateSid(sid) || !validateExp(expRaw)) {
      return new Response("KCTV session expired", {
        status: 401,
        headers: cors,
      });
    }

    const normalizedTarget = normalizeKoryoPath(target, "/");
    if (!normalizedTarget || !isAllowedKoryoTarget(normalizedTarget)) {
      return new Response("Invalid KCTV target", {
        status: 403,
        headers: cors,
      });
    }

    const playlistId = extractPlaylistId(normalizedTarget);
    await refreshSession(sid, playlistId);

    const upstream = await fetch(`${KORYO_ORIGIN}${normalizedTarget}`, {
      method: "GET",
      headers: buildKoryoHeaders({ sid }),
    });

    const contentType = upstream.headers.get("content-type") || "";
    const isManifest =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      normalizedTarget.toLowerCase().endsWith(".m3u8");

    if (isManifest) {
      const manifest = await upstream.text();
      const nextExp = Date.now() + 25_000;
      const rewritten = rewriteManifest(manifest, normalizedTarget, sid, nextExp);

      return new Response(rewritten, {
        status: upstream.status,
        headers: {
          ...cors,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
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
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err?.message || "Unknown KCTV proxy error",
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
  path: "/api/kctv-proxy",
};
