export default async (request) => {
  const url = new URL(request.url);
  const streamUrl = url.searchParams.get("url");

  const isPrivateIp = (hostname) => {
    const normalized = hostname.trim().toLowerCase();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return false;
    const parts = normalized.split(".").map((p) => Number(p));
    if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  };

  const isBlockedHost = (hostname) => {
    const h = (hostname || "").toLowerCase();
    return (
      h === "localhost" ||
      h.endsWith(".localhost") ||
      h.endsWith(".local") ||
      h === "::1" ||
      h === "[::1]" ||
      isPrivateIp(h)
    );
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  if (!streamUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // Allow public media hosts but block local/private targets to prevent SSRF abuse.
  let parsed;
  try {
    parsed = new URL(streamUrl);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return new Response("Protocol not allowed", { status: 403 });
  }

  if (isBlockedHost(parsed.hostname)) {
    return new Response("Host not allowed", { status: 403 });
  }

  try {
    // Fetch the stream URL, following redirects automatically
    const response = await fetch(streamUrl);
    const contentType = response.headers.get("content-type") || "";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    // For m3u8 manifests, rewrite internal URLs to go through the proxy
    if (
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      streamUrl.endsWith(".m3u8")
    ) {
      const body = await response.text();
      const finalManifestUrl = response.url || streamUrl;

      const lines = body.split("\n");
      const rewritten = lines.map((line) => {
        const trimmed = line.trim();

        // Empty lines
        if (!trimmed) return line;

        // Handle URI= attributes in tags (e.g., #EXT-X-KEY)
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (_match, uri) => {
            const absUri = new URL(uri, finalManifestUrl).toString();
            return `URI="/api/stream-proxy?url=${encodeURIComponent(absUri)}"`;
          });
        }

        // Skip other comment/tag lines
        if (trimmed.startsWith("#")) return line;

        // This is a URL line (segment or sub-playlist)
        const absUrl = new URL(trimmed, finalManifestUrl).toString();
        return `/api/stream-proxy?url=${encodeURIComponent(absUrl)}`;
      });

      return new Response(rewritten.join("\n"), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.apple.mpegurl",
        },
      });
    }

    // For segments (ts, aac, etc.), stream through directly
    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": contentType || "video/mp2t",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
};

export const config = {
  path: "/api/stream-proxy",
};
