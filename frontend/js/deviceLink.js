/**
 * Mobile Connect - the browser half.
 *
 * One QR, two backends. HolDEX proper and TrenchScanner are separate services with separate
 * databases and separate notions of "who is this", so pairing a phone means pairing it twice.
 * The desktop mints one code from each and packs both into a single link; the phone redeems both
 * on arrival. Either half can be missing (you might be signed into Trenches but have no wallet
 * connected here, or the reverse) and the flow still works for the half that is available.
 *
 * What the phone ends up holding is deliberately unequal, because the two sides are not the same
 * kind of thing:
 *
 *   - Trenches has real accounts, so the phone gets a real Trenches session, in a cookie, and can
 *     do everything the desktop can.
 *   - This site has no accounts at all. Identity here is a wallet in the browser and every write
 *     is signed at the moment it happens. A phone cannot be given that - the key never leaves the
 *     desktop's wallet - so what it gets is a proof of which wallet it belongs to, which is enough
 *     for personalised reads and nothing more. Writing still asks for a wallet on the phone.
 *
 * That asymmetry is the point rather than an omission: a device token that leaked would show
 * somebody a watchlist, not let them act as its owner.
 */
const deviceLink = {
  /**
   * Fallback only, for a backend that does not report its own TTL. Both of them do, and the
   * countdown uses what they say (see mintSiteCode / mintTrenchesCode): a constant duplicated
   * across three codebases is a constant that will eventually disagree with two of them, and the
   * failure mode is a QR that reads as live after it is dead.
   */
  CODE_TTL_MS: 2 * 60 * 1000,

  /**
   * Turns a TTL into a deadline on THIS clock. Deliberately built from the relative ttlMs rather
   * than the absolute expiresAt a server may also send: a phone or desktop with a skewed clock
   * would misread an absolute timestamp, and skew of a few minutes is common enough to matter
   * against a two-minute window.
   */
  deadlineFrom(ttlMs) {
    const ttl = Number(ttlMs);
    return Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : this.CODE_TTL_MS);
  },

  siteApi() {
    return (typeof config !== 'undefined' && config.api?.baseUrl) || '';
  },
  trenchesApi() {
    return (typeof config !== 'undefined' && config.api?.trenchesUrl) || '';
  },
  key(name) {
    return (typeof config !== 'undefined' && config.storageKeys?.[name]) || `holdex_${name}`;
  },

  // ---------------------------------------------------------------- device session (this site)

  /** The paired phone's own credential, or null on a desktop that has never been paired. */
  getSession() {
    try {
      const token = localStorage.getItem(this.key('deviceSession'));
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
      return { token, wallet: localStorage.getItem(this.key('deviceWallet')) || null };
    } catch (_) {
      // Private mode, or storage disabled. Not being paired is a valid state, not an error.
      return null;
    }
  },

  setSession(token, wallet) {
    try {
      localStorage.setItem(this.key('deviceSession'), token);
      if (wallet) localStorage.setItem(this.key('deviceWallet'), wallet);
    } catch (_) { /* nothing we can do, and nothing that should break the page */ }
  },

  clearSession() {
    try {
      localStorage.removeItem(this.key('deviceSession'));
      localStorage.removeItem(this.key('deviceWallet'));
    } catch (_) { /* as above */ }
  },

  // ------------------------------------------------------------------------------ the QR payload

  /**
   * Both codes ride in the URL *fragment*, never the query string. A fragment is never sent to
   * the server, so these single-use credentials stay out of access logs, out of the Referer
   * header, and out of any analytics that records full URLs. The landing page strips it from the
   * address bar as soon as it has read it, so a screenshot or a shoulder-surfer gets nothing.
   */
  buildLinkUrl(origin, siteToken, trenchesToken) {
    return `${origin}/link.html#${siteToken || ''}.${trenchesToken || ''}`;
  },

  /** The inverse. Anything malformed reads as "absent" rather than throwing - the page is meant
   *  to say "this link isn't valid any more", not to break. */
  parseLinkHash(hash) {
    const raw = (hash || '').replace(/^#/, '');
    const [site, trenches] = raw.split('.');
    const ok = (t) => (typeof t === 'string' && /^[a-f0-9]{64}$/.test(t) ? t : null);
    return { siteToken: ok(site), trenchesToken: ok(trenches) };
  },

  // ------------------------------------------------------------------------------- desktop side

  /**
   * Mint this site's half, and get back the phones already paired in the same response.
   *
   * Authorised by a wallet signature - the same mechanism that authorises a watchlist write -
   * because there is no session here to authorise it with. Signatures are single-use server-side,
   * which is why the device list comes back from THIS call rather than from a second signed one:
   * two prompts to render one screen trains people to click Approve without reading.
   */
  async mintSiteCode(wallet) {
    const timestamp = Date.now();
    const message = `HolDEX Link Device: ${wallet.address} at ${timestamp}`;
    const signed = await wallet.signMessage(message);
    const res = await fetch(`${this.siteApi()}/api/device/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: signed.address,
        signature: signed.signature,
        signatureTimestamp: timestamp
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not create a pairing code');
    return {
      pairingToken: data.pairingToken,
      // Measured from now, which is when this response arrived - so the clock the user sees
      // starts where the server's did, not where the page decided it should.
      expiresAt: this.deadlineFrom(data.expiresInMs),
      devices: data.devices || []
    };
  },

  /**
   * Mint Trenches' half from the Trenches session cookie. Returns null rather than throwing when
   * there is no session: not being signed into Trenches is an ordinary state, and the desktop
   * panel says so instead of failing the whole pairing.
   */
  /* eslint-disable-next-line no-unused-vars */
  async mintTrenchesCode() {
    try {
      // No Content-Type header, because there is no body. Declaring application/json on an
      // empty POST makes Fastify's JSON parser reject the request at 400 before the route ever
      // runs - which reads exactly like "not signed in" and is not.
      const res = await fetch(`${this.trenchesApi()}/auth/link/code`, {
        method: 'POST',
        credentials: 'include'
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data.code !== 'string') return null;
      return { code: data.code, expiresAt: this.deadlineFrom(data.ttlMs) };
    } catch (_) {
      return null;
    }
  },

  // --------------------------------------------------------------------------------- phone side

  /** Redeem this site's half. Returns the wallet the phone is now recognised as. */
  async redeemSiteCode(pairingToken) {
    const res = await fetch(`${this.siteApi()}/api/device/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingToken })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'This code is not valid any more');
    this.setSession(data.sessionToken, data.wallet);
    return data.wallet;
  },

  /** Redeem Trenches' half. The session arrives as a cookie, so there is nothing to store here -
   *  which is also why credentials must be included on both this call and every later one. */
  async redeemTrenchesCode(code) {
    const res = await fetch(`${this.trenchesApi()}/auth/link/redeem`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error === 'invalid_or_expired'
      ? 'This code is not valid any more'
      : (data.error || 'Could not link Trenches'));
    return data.walletAddress;
  },

  // ------------------------------------------------------------------------- managing what is linked

  /** The phones paired to this site, signed so a public wallet address cannot be used to
   *  enumerate somebody else's devices. Costs a wallet prompt, so the pairing screen reads the
   *  list off mintSiteCode instead; this exists for refreshing it on its own. */
  async listSiteDevices(wallet) {
    const timestamp = Date.now();
    const signed = await wallet.signMessage(`HolDEX Link Device: ${wallet.address} at ${timestamp}`);
    const res = await fetch(`${this.siteApi()}/api/device/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: signed.address,
        signature: signed.signature,
        signatureTimestamp: timestamp
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load linked devices');
    return data.devices || [];
  },

  /** Revoke one device, or every device, on this site. `deviceId` null means all of them. */
  async revokeSiteDevice(wallet, deviceId) {
    const timestamp = Date.now();
    const signed = await wallet.signMessage(`HolDEX Link Device: ${wallet.address} at ${timestamp}`);
    const res = await fetch(`${this.siteApi()}/api/device/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: signed.address,
        signature: signed.signature,
        signatureTimestamp: timestamp,
        ...(deviceId === null ? { all: true } : { deviceId })
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not disconnect');
    return data.revoked || 0;
  },

  /** The phones paired to Trenches. Empty when this browser has no Trenches session, which is
   *  not an error - it just means there is nothing of theirs to show. */
  async listTrenchesDevices() {
    try {
      const res = await fetch(`${this.trenchesApi()}/auth/devices`, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.devices || [];
    } catch (_) {
      return null;
    }
  },

  async revokeTrenchesDevice(deviceId) {
    const path = deviceId === null ? '/auth/devices' : `/auth/devices/${encodeURIComponent(deviceId)}`;
    const res = await fetch(`${this.trenchesApi()}${path}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Could not disconnect');
    return true;
  },

  // -------------------------------------------------------------------------------------- display

  /**
   * Turn a user-agent string into something a person can recognise in a list. Best-effort by
   * design: the goal is "is this the phone in my hand?", and the honest answer when the string is
   * unfamiliar is to say so rather than to guess confidently.
   *
   * The result is only ever assigned via textContent - a user-agent is attacker-controlled text.
   */
  describeDevice(userAgent) {
    if (!userAgent) return 'Unknown device';
    const ua = String(userAgent);
    const os =
      /iPhone/i.test(ua) ? 'iPhone' :
      /iPad/i.test(ua) ? 'iPad' :
      /Android/i.test(ua) ? 'Android' :
      /Macintosh|Mac OS X/i.test(ua) ? 'Mac' :
      /Windows/i.test(ua) ? 'Windows' :
      /Linux/i.test(ua) ? 'Linux' : null;
    // Order matters: Edge and Chrome both claim "Safari", Chrome claims "Edg" nowhere.
    const browser =
      /Edg\//i.test(ua) ? 'Edge' :
      /OPR\//i.test(ua) ? 'Opera' :
      /Firefox\//i.test(ua) ? 'Firefox' :
      /Chrome\//i.test(ua) ? 'Chrome' :
      /Safari\//i.test(ua) ? 'Safari' : null;
    if (os && browser) return `${os} · ${browser}`;
    return os || browser || 'Unknown device';
  },

  /** "3 minutes ago" for the device list. Coarse on purpose - nobody needs seconds here. */
  timeAgo(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
};

if (typeof window !== 'undefined') window.deviceLink = deviceLink;
