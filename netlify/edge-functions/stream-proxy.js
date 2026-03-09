export default async (request) => {
  const url = new URL(request.url);
  const streamUrl = url.searchParams.get("url");

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

  // Only allow proxying netplus.ch domains for security
  let parsed;
  try {
    parsed = new URL(streamUrl);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  if (!parsed.hostname.endsWith("netplus.ch")) {
    return new Response("Domain not allowed", { status: 403 });
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
      const base = streamUrl.substring(0, streamUrl.lastIndexOf("/") + 1);

      // Get the final URL after redirects to use as base for relative paths
      const finalBase = response.url
        ? response.url.substring(0, response.url.lastIndexOf("/") + 1)
        : base;

      const lines = body.split("\n");
      const rewritten = lines.map((line) => {
        const trimmed = line.trim();

        // Empty lines
        if (!trimmed) return line;

        // Handle URI= attributes in tags (e.g., #EXT-X-KEY)
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (_match, uri) => {
            const absUri = uri.startsWith("http") ? uri : finalBase + uri;
            return `URI="/api/stream-proxy?url=${encodeURIComponent(absUri)}"`;
          });
        }

        // Skip other comment/tag lines
        if (trimmed.startsWith("#")) return line;

        // This is a URL line (segment or sub-playlist)
        const absUrl = trimmed.startsWith("http") ? trimmed : finalBase + trimmed;
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
