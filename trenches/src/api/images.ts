/**
 * Token artwork has to be fetched through the site's own image proxy, never hotlinked.
 *
 * Almost every token logo in this band lives on a public IPFS gateway or a launchpad CDN, and
 * those hosts fail in two ways a browser cannot recover from:
 *
 *  - They rate-limit or refuse hotlinks outright, which arrives as a 403.
 *  - Their error responses carry no permissive Cross-Origin-Resource-Policy, so the browser
 *    blocks even the failure with net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin - the exact pair
 *    of errors this module exists to stop.
 *
 * The backend proxy (GET /api/image-proxy) fetches server-side, caches the bytes in Redis for
 * every visitor at once, de-dupes concurrent requests for the same URL, and re-serves with
 * `Cross-Origin-Resource-Policy: cross-origin`. The main site already routes all of its table
 * logos through it; this is the same helper for the Trenches app.
 */

/**
 * The site backend that hosts the proxy - a different service from VITE_API_URL, which points
 * at the TrenchScanner API. Mirrors the hostname switch in the main site's config.js so the two
 * cannot disagree about where the proxy lives; the env var is the override for anyone running
 * the backend somewhere else.
 */
const SITE_API_URL: string =
  import.meta.env.VITE_SITE_API_URL ||
  (typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://localhost:3000"
    : "https://cultscreener-api.onrender.com");

/**
 * The two sizes the proxy will resize to. Anything else is ignored server-side and served at
 * "avatar", so this type is the honest description of the choice rather than a free number.
 *
 *  - "avatar"   (512px) for list tiles and thumbnails.
 *  - "backdrop" (1024px) for the PumpScroll card, which is full-bleed and then scaled up again by
 *    the card's own transform. At 512 that meant upscaling a small image across a whole phone
 *    screen, and the only way to hide the softness was to blur it into abstraction.
 */
export type ArtworkSize = "avatar" | "backdrop";

const SIZE_PX: Record<ArtworkSize, number> = { avatar: 512, backdrop: 1024 };

/**
 * Rewrites a third-party image URL to go through the proxy. Left untouched: data: URIs (already
 * inline), anything already proxied, and non-https sources, which the proxy declines anyway.
 * A null/absent URL passes straight through so callers can keep their own "no artwork" branch.
 */
export function proxiedImageUrl(
  url: string | null | undefined,
  size: ArtworkSize = "avatar",
): string | null | undefined {
  if (!url) return url;
  if (url.startsWith("data:") || url.includes("/api/image-proxy")) return url;
  try {
    if (new URL(url).protocol !== "https:") return url;
  } catch {
    return url; // not a URL we can reason about - hand it back rather than mangling it
  }
  return `${SITE_API_URL}/api/image-proxy?url=${encodeURIComponent(url)}&w=${SIZE_PX[size]}`;
}
