/**
 * Mobile Connect - the browser half.
 *
 * The desktop mints a single-use code and packs it into a link; the phone redeems it on arrival.
 *
 * This site has no accounts. Identity here is a wallet in the browser and every write is signed
 * at the moment it happens. A phone cannot be given that - the key never leaves the desktop's
 * wallet - so what it gets is a proof of which wallet it belongs to, which is enough for
 * personalised reads and nothing more. Writing still asks for a wallet on the phone. A device
 * token that leaked would show somebody a watchlist, not let them act as its owner.
 *
 * (The QR used to carry a second code for the in-site Trenches app. That app moved to
 * trenchscanner.app, which this site has no session for, so the code now pairs HolDEX only.)
 */
const deviceLink = {
  /**
   * Fallback only, for a backend that does not report its own TTL. The backend does, and the
   * countdown uses what it says (see mintSiteCode): a constant duplicated across codebases will
   * eventually disagree, and the failure mode is a QR that reads as live after it is dead.
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
   * The code rides in the URL *fragment*, never the query string. A fragment is never sent to
   * the server, so these single-use credentials stay out of access logs, out of the Referer
   * header, and out of any analytics that records full URLs. The landing page strips it from the
   * address bar as soon as it has read it, so a screenshot or a shoulder-surfer gets nothing.
   */
  buildLinkUrl(origin, siteToken) {
    return `${origin}/link.html#${siteToken || ''}`;
  },

  /** The inverse. Anything malformed reads as "absent" rather than throwing - the page is meant
   *  to say "this link isn't valid any more", not to break. Reads only the part before any
   *  '.', which is where older two-code links kept this site's half. */
  parseLinkHash(hash) {
    const raw = (hash || '').replace(/^#/, '');
    const [site] = raw.split('.');
    const ok = (t) => (typeof t === 'string' && /^[a-f0-9]{64}$/.test(t) ? t : null);
    return { siteToken: ok(site) };
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
