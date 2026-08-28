/**
 * Agents that refuse to connect to anything on a private network.
 *
 * This is what lets the image proxy fetch from ANY host instead of a curated allowlist. The
 * allowlist was never really about which hosts are trustworthy - it was a blunt way of making
 * sure the proxy could not be pointed at our own infrastructure. That is a property of the
 * ADDRESS, not of the name, so it is better enforced at the address.
 *
 * The check runs inside the agent's `lookup`, which the runtime calls once per connection. That
 * matters for two attacks a plain "resolve, check, then fetch" misses:
 *
 *   - DNS rebinding: a name that answers with a public address when checked and 127.0.0.1 a
 *     moment later when actually connected. Here the checked answer IS the one connected to.
 *   - Redirects: every hop opens a new connection through the same agent, so a public URL that
 *     302s to http://169.254.169.254/ is stopped at the hop, not merely at the entry point.
 */
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

/**
 * Address ranges no outbound fetch of ours has any business reaching. Cloud metadata endpoints
 * (169.254.169.254 on essentially every provider) fall under link-local, which is the single most
 * important line here: that is the address that turns an image proxy into credential disclosure.
 */
function isBlockedAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;                         // "this network"
    if (a === 10) return true;                        // private
    if (a === 127) return true;                       // loopback
    if (a === 169 && b === 254) return true;          // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;          // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;            // IETF protocol assignments / 192.0.2.0 docs
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                        // multicast + reserved + broadcast
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:10.0.0.1) has to be judged as the IPv4 address it carries, or every
    // rule above is trivially bypassed on a dual-stack host.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;   // unspecified, loopback
    if (lower.startsWith('fe80')) return true;             // link-local
    if (/^f[cd]/.test(lower)) return true;                 // unique-local
    if (lower.startsWith('ff')) return true;               // multicast
    if (lower.startsWith('64:ff9b')) return true;          // NAT64, a route back to IPv4 space
    return false;
  }
  // Not an address we can reason about - refuse rather than guess.
  return true;
}

/**
 * A drop-in for dns.lookup that hides every private answer. Resolving with `all` and filtering
 * (rather than taking the first result and testing it) matters for a name that returns a mix:
 * the connection then uses a vetted address instead of whichever came first.
 */
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : options || {};
  const done = typeof options === 'function' ? options : callback;

  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return done(err);
    const safe = (addresses || []).filter((a) => !isBlockedAddress(a.address));
    if (safe.length === 0) {
      const blocked = new Error(`Refusing to connect to a private address for ${hostname}`);
      blocked.code = 'EBLOCKEDADDRESS';
      return done(blocked);
    }
    if (opts.all) return done(null, safe);
    return done(null, safe[0].address, safe[0].family);
  });
}

// keepAlive because a busy feed pulls many images from the same few gateways, and the TLS
// handshake is the expensive part of each one. maxSockets bounds how hard we lean on any single
// host - a public IPFS gateway answers a stampede with a 429.
const agentOptions = { lookup: guardedLookup, keepAlive: true, maxSockets: 24, timeout: 8000 };
const safeHttpAgent = new http.Agent(agentOptions);
const safeHttpsAgent = new https.Agent(agentOptions);

/**
 * A hostname that is ALREADY a private address, judged without resolving anything.
 *
 * Cheap, and the one check that still works when the request will leave through an egress proxy -
 * see agentsFor. Bracketed IPv6 literals arrive from `new URL(...).hostname` as `[::1]`.
 */
function isBlockedHostLiteral(hostname) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (!net.isIP(bare)) return false;
  return isBlockedAddress(bare);
}

/**
 * The agents to hand axios, or nothing.
 *
 * A custom agent takes over the connection completely, which means it also takes over from
 * axios's proxy handling: passing one where HTTPS_PROXY is set does not merely lose the guard,
 * it loses all outbound access, silently, as a 502 on every image. So when an egress proxy is
 * configured we deliberately stand down.
 *
 * That is not a hole. Behind an egress proxy the app cannot open sockets of its own at all - the
 * proxy decides what is reachable, and it, not this module, is the network boundary. The DNS
 * guard is unavailable there by construction anyway: the proxy resolves the target, we never do.
 * isBlockedHostLiteral still applies in both modes.
 */
function agentsFor() {
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxied) return {};
  return { httpAgent: safeHttpAgent, httpsAgent: safeHttpsAgent };
}

module.exports = {
  isBlockedAddress,
  isBlockedHostLiteral,
  guardedLookup,
  agentsFor,
  safeHttpAgent,
  safeHttpsAgent,
};
