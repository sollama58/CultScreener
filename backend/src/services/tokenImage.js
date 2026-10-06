/**
 * Token image URLs and bytes, made safe to store and serve.
 *
 * Token metadata reaches us from several sources, and not every "image" value is a URL a browser
 * can load:
 *
 *   - GeckoTerminal answers `image_url: "missing.png"` for a token it has no art for. Stored as-is
 *     that is a relative path: the browser asked holdex.live for /missing.png, got a 404, and the
 *     token showed the fallback logo. Worse, every logo write COALESCEs with the stored value, so a
 *     real logo arriving later from DexScreener or Helius never replaced it.
 *   - Metaplex metadata can carry `ipfs://CID` or `ar://ID`, which no browser loads directly.
 *
 * normalizeLogoUri turns those into either a loadable https URL or null, so the caller's
 * "no logo yet" path applies and a later source can fill it in.
 */

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const ARWEAVE_GATEWAY = 'https://arweave.net/';

function normalizeLogoUri(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^ipfs:\/\//i.test(raw)) return IPFS_GATEWAY + raw.replace(/^ipfs:\/\/(ipfs\/)?/i, '');
  if (/^ar:\/\//i.test(raw)) return ARWEAVE_GATEWAY + raw.replace(/^ar:\/\//i, '');
  let url;
  try { url = new URL(raw); } catch { return null; } // relative ("missing.png") or junk
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // An http image never loads on an https page (browsers upgrade it and fail if the host has no
  // https), and the image proxy only fetches https, so try the https form instead.
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (/\/missing(_[a-z]+)?\.png$/i.test(url.pathname)) return null;
  return url.href;
}

/**
 * The image type of a buffer judged by its first bytes, or null if it is not an image we serve.
 *
 * IPFS gateways, Arweave/Irys and S3 buckets routinely label real PNGs as
 * application/octet-stream or text/plain. The proxy used to refuse anything not labelled image/*,
 * which turned those logos into a 502 and the fallback.
 */
function sniffImageType(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('ascii', 8, 12))) return 'image/avif';
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/**
 * Other places the same image can be fetched from, for when the original host fails.
 *
 * Most token art lives on IPFS behind ipfs.io, and ipfs.io routinely refuses or times out on
 * requests from cloud servers - the image proxy answered 502 for those logos even though the
 * browser could load them. The same content is addressable on any gateway by its CID, so an
 * IPFS URL (path form /ipfs/CID/... on any host, or subdomain form CID.ipfs.host) gets the other
 * public gateways. Every image, IPFS or not, also gets Helius's image CDN, which fetches and
 * caches the original from Cloudflare's network rather than ours.
 *
 * Returns https URLs on fixed hosts, never including the original.
 */
const IPFS_FALLBACK_GATEWAYS = [
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
];
const HELIUS_IMAGE_CDN = 'https://cdn.helius-rpc.com/cdn-cgi/image//';
const CID_RE = /^[a-zA-Z0-9]{20,}$/;

function ipfsContentPath(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const rest = (path) => (path && path !== '/' ? path : '') + u.search;
  const pathForm = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(u.pathname);
  if (pathForm && CID_RE.test(pathForm[1])) return pathForm[1] + rest(pathForm[2]);
  const subdomainForm = /^([a-z0-9]+)\.ipfs\./i.exec(u.hostname);
  if (subdomainForm && CID_RE.test(subdomainForm[1])) return subdomainForm[1] + rest(u.pathname);
  return null;
}

function imageSourceFallbacks(url) {
  let host;
  try { host = new URL(url).host; } catch { return []; }
  const out = [];
  const contentPath = ipfsContentPath(url);
  if (contentPath) {
    for (const gateway of IPFS_FALLBACK_GATEWAYS) {
      if (new URL(gateway).host !== host) out.push(gateway + contentPath);
    }
  }
  if (host !== new URL(HELIUS_IMAGE_CDN).host) out.push(HELIUS_IMAGE_CDN + url);
  return out;
}

module.exports = { normalizeLogoUri, sniffImageType, ipfsContentPath, imageSourceFallbacks };
