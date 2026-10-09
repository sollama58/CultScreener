/**
 * Small pieces of the routes and handlers defined inline in app.js, kept here so they can be
 * tested without starting the server (requiring app.js listens on a port and installs process
 * handlers).
 */

const PLACEHOLDER_NAMES = new Set(['unknown token', 'unknown', '']);

/**
 * The batch:<mint> entry the boot cache warm writes from a GeckoTerminal multi-token result.
 * Same shape as the GeckoTerminal branch of POST /api/tokens/batch (routes/tokens.js): the
 * frontend matches batch rows by address/mintAddress, so a raw getMultiTokenInfo object (which
 * has neither) was served and then silently dropped from watchlist enrichment.
 * Returns null when GeckoTerminal has no usable name: the batch route then resolves the token
 * itself (DB, Helius) instead of being handed a placeholder.
 */
function warmBatchEntry(mint, g) {
  if (!g || !g.name || PLACEHOLDER_NAMES.has(String(g.name).toLowerCase())) return null;
  return {
    mintAddress: mint,
    address: mint,
    name: g.name,
    symbol: g.symbol || mint.slice(0, 5).toUpperCase(),
    decimals: g.decimals || 9,
    logoUri: g.logoUri || null,
    logoURI: g.logoUri || null,
    price: g.price || 0,
    priceChange24h: g.priceChange24h ?? null,
    volume24h: g.volume24h || 0,
    marketCap: g.marketCap || null
  };
}

/**
 * The response for a request-body error raised by express.json (body-parser): a malformed or
 * oversized body is the client's mistake, not an 'Internal server error'.
 * Returns { statusCode, userMessage, errorCode } or null for any other error.
 */
function bodyParserErrorResponse(err) {
  switch (err && err.type) {
    case 'entity.parse.failed':
      return { statusCode: 400, userMessage: 'Malformed JSON body', errorCode: 'INVALID_JSON' };
    case 'entity.too.large':
      return { statusCode: 413, userMessage: 'Request body too large', errorCode: 'PAYLOAD_TOO_LARGE' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { statusCode: 415, userMessage: 'Unsupported request body encoding', errorCode: 'UNSUPPORTED_ENCODING' };
    case 'request.aborted':
    case 'request.size.invalid':
    case 'stream.encoding.set':
    case 'stream.not.readable':
    case 'parameters.too.many':
      return { statusCode: err.status || 400, userMessage: 'Invalid request body', errorCode: 'INVALID_BODY' };
    default:
      return null;
  }
}

/**
 * True when the request names a page (Origin, else Referer) that is neither one of the site's
 * origins nor this API host itself - i.e. another site embedding the image proxy. Requests that
 * name no page at all (curl, no-referrer policies) are not judged here.
 */
function isForeignPageRequest(req, allowedOrigins) {
  let page = req.headers.origin;
  if (!page || page === 'null') {
    const referer = req.headers.referer;
    if (!referer) return false;
    try { page = new URL(referer).origin; } catch { return false; }
  }
  const origin = String(page).replace(/\/$/, '');
  if (allowedOrigins.includes(origin)) return false;
  try {
    if (new URL(origin).host === req.headers.host) return false;
  } catch { /* unparseable origin: foreign */ }
  return true;
}

module.exports = { warmBatchEntry, bodyParserErrorResponse, isForeignPageRequest };
