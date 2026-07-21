import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// Cache en mémoire (LRU simple) — 500 entrées max, TTL 1h.
const cache = new Map<string, { data: LinkMeta; ts: number }>();
const MAX_CACHE = 500;
const TTL_MS = 60 * 60 * 1000; // 1 heure

interface LinkMeta {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  favicon?: string;
}

function getCached(url: string): LinkMeta | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(url);
    return null;
  }
  return entry.data;
}

function setCache(url: string, data: LinkMeta) {
  // Éviction LRU basique
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, { data, ts: Date.now() });
}

// GET /api/link-preview?url=https://example.com
// Scrappe les meta tags OpenGraph d'une URL.
export const GET = withAuth(async (req: NextRequest, _userId: string) => {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) return fail("Paramètre 'url' manquant", 400, "NO_URL");

  // Validation basique
  try {
    new URL(url);
  } catch {
    return fail("URL invalide", 400, "BAD_URL");
  }

  // Vérifie le cache
  const cached = getCached(url);
  if (cached) return ok(cached);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s max

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AlanyaBot/1.0)",
        "Accept": "text/html",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return fail(`Page inaccessible (${res.status})`, 422, "FETCH_ERROR");
    }

    const html = await res.text();
    const meta = parseOpenGraph(html, url);

    setCache(url, meta);
    return ok(meta);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return fail("Délai d'attente dépassé", 408, "TIMEOUT");
    }
    console.error("[link-preview] Erreur scraping:", err);
    return fail("Impossible de récupérer la page", 502, "SCRAPE_ERROR");
  }
});

// ── Parser OpenGraph / meta tags ──────────────────────────────────────

function parseOpenGraph(html: string, originalUrl: string): LinkMeta {
  const meta: LinkMeta = { url: originalUrl };

  // Fonction utilitaire pour extraire un attribut meta
  const getMeta = (property: string): string | undefined => {
    // Cherche <meta property="og:xxx" content="..."> ou <meta name="xxx" content="...">
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegex(property)}["']`, "i"),
      new RegExp(`<meta[^>]+name=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegex(property)}["']`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return decodeEntities(m[1]);
    }
    return undefined;
  };

  // Titre
  meta.title = getMeta("og:title") ?? getMeta("twitter:title");
  if (!meta.title) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) meta.title = decodeEntities(titleMatch[1].trim());
  }

  // Description
  meta.description = getMeta("og:description") ?? getMeta("twitter:description") ?? getMeta("description");

  // Image
  meta.imageUrl = getMeta("og:image") ?? getMeta("twitter:image");
  if (meta.imageUrl && !meta.imageUrl.startsWith("http")) {
    try {
      meta.imageUrl = new URL(meta.imageUrl, originalUrl).href;
    } catch {}
  }

  // Site name
  meta.siteName = getMeta("og:site_name");
  if (!meta.siteName) {
    try {
      meta.siteName = new URL(originalUrl).host.replace("www.", "");
    } catch {}
  }

  // Favicon
  const faviconMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
  if (faviconMatch?.[1]) {
    meta.favicon = faviconMatch[1].startsWith("http")
      ? faviconMatch[1]
      : new URL(faviconMatch[1], originalUrl).href;
  }

  return meta;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
