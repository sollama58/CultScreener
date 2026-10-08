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
 *
 * The runtime does NOT call `lookup` for a host that is already an IP literal, so the agents also
 * judge literals in `createConnection` - otherwise a redirect to a bare private address would
 * sail straight past the lookup guard.
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
    // rule above is trivially bypassed on a dual-stack host. Judge it from the expanded groups so
    // the hex spelling `new URL()` normalises to (::ffff:7f00:1) is caught too.
    const g = expandIPv6(lower);
    if (!g) return true;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedAddress(groupsToIPv4(g));
    // IPv4-compatible (::a.b.c.d, deprecated) and ::/::1 - nothing public lives in ::/96.
    if (g.slice(0, 6).every((x) => x === 0)) return true;
    if (lower.startsWith('fe80')) return true;             // link-local
    if (/^f[cd]/.test(lower)) return true;                 // unique-local
    if (lower.startsWith('ff')) return true;               // multicast
    if (lower.startsWith('64:ff9b')) return true;          // NAT64, a route back to IPv4 space
    return false;
  }
  // Not an address we can reason about - refuse rather than guess.
  return true;
}

/** Expand an IPv6 address (net.isIP() === 6) into its eight 16-bit groups, or null. */
function expandIPv6(ip) {
  let addr = ip.split('%')[0];
  // A trailing dotted quad stands for the last two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    addr = addr.slice(0, quad.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array(fill).fill('0'), ...tail].map((h) => parseInt(h, 16));
  if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return groups;
}

function groupsToIPv4(g) {
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
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
const safeHttpAgent = guardLiterals(new http.Agent(agentOptions));
const safeHttpsAgent = guardLiterals(new https.Agent(agentOptions));

/**
 * Judge IP-literal hosts at connect time. `lookup` only runs for names, so without this a hop to
 * http://127.0.0.1/ or http://169.254.169.254/ (e.g. via a redirect) would connect unchecked.
 * Failing through the callback makes the request emit 'error' as for any other connect failure.
 */
function guardLiterals(agent) {
  const createConnection = agent.createConnection;
  agent.createConnection = function guardedCreateConnection(options, callback) {
    const host = String((options && (options.host || options.hostname)) || '');
    if (isBlockedHostLiteral(host)) {
      const blocked = new Error(`Refusing to connect to a private address ${host}`);
      blocked.code = 'EBLOCKEDADDRESS';
      if (typeof callback === 'function') {
        callback(blocked);
        return undefined;
      }
      throw blocked;
    }
    return createConnection.apply(this, arguments);
  };
  return agent;
}

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
