/**
 * The desktop pairing screen.
 *
 * Sequence: connect a wallet, sign once, get a QR that carries the pairing code and a
 * list of the phones already connected. The single signature is the design constraint the whole
 * page is arranged around - see deviceLink.mintSiteCode.
 */
(function connectPhonePage() {
  const el = (id) => document.getElementById(id);

  const dom = {
    gate: el('dl-gate'),
    gateBtn: el('dl-connect-wallet'),
    main: el('dl-main'),
    qr: el('dl-qr'),
    qrFrame: el('dl-qr-frame'),
    veil: el('dl-qr-veil'),
    veilText: el('dl-veil-text'),
    refresh: el('dl-refresh'),
    regen: el('dl-regen'),
    countdown: el('dl-countdown'),
    manual: el('dl-manual'),
    manualUrl: el('dl-manual-url'),
    copy: el('dl-copy'),
    siteNote: el('dl-scope-site-note'),
    siteDot: el('dl-scope-site')?.querySelector('.dl-dot'),
    devices: el('dl-devices'),
    deviceList: el('dl-device-list'),
    revokeAll: el('dl-revoke-all')
  };

  const state = {
    /** null until a code has been minted. Cleared on expiry so nothing stale is copyable. */
    linkUrl: null,
    expiresAt: 0,
    ticker: null,
    minting: false,
    /** The wallet the showing code and device list belong to (an account switch must re-mint). */
    mintedFor: null,
    siteDevices: []
  };

  // ------------------------------------------------------------------------------ small helpers

  function setScope(dot, note, stateName, text) {
    if (dot) dot.dataset.state = stateName;
    if (note) note.textContent = text;
  }

  // --------------------------------------------------------------------------------- the QR itself

  function renderQr(url) {
    // Level M: enough redundancy to survive a phone camera at an angle without pushing the
    // module count so high that the code needs a big screen to resolve.
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    // createSvgTag with scalable:true emits a viewBox and no fixed width, so the CSS box decides
    // the size and the code stays crisp at any of them.
    dom.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    dom.qrFrame.dataset.loading = 'false';
  }

  function startCountdown() {
    stopCountdown();
    const tick = () => {
      const left = state.expiresAt - Date.now();
      if (left <= 0) {
        expire();
        return;
      }
      const secs = Math.ceil(left / 1000);
      dom.countdown.textContent = `Expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      dom.countdown.dataset.urgent = secs <= 20 ? 'true' : 'false';
    };
    tick();
    state.ticker = setInterval(tick, 1000);
  }

  function stopCountdown() {
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = null;
  }

  /**
   * The code is gone. The URL is dropped from memory as well as from the screen - a copy button
   * that hands out a dead credential is worse than no copy button.
   */
  function expire() {
    stopCountdown();
    state.linkUrl = null;
    dom.veil.hidden = false;
    dom.manual.hidden = true;
    dom.regen.hidden = true;
    dom.countdown.textContent = 'Code expired';
    dom.countdown.dataset.urgent = 'false';
  }

  // ------------------------------------------------------------------------------- minting a code

  async function mint() {
    if (state.minting) return;
    state.minting = true;
    dom.refresh.disabled = true;
    dom.regen.disabled = true;
    dom.veil.hidden = true;
    dom.qrFrame.dataset.loading = 'true';
    dom.qr.innerHTML = '';
    dom.countdown.textContent = 'Waiting for your signature…';
    setScope(dom.siteDot, dom.siteNote, 'pending', 'Waiting for your signature…');

    let siteToken = null;
    const forAddress = wallet.address;
    // The server grants the TTL, so the deadline comes from it, not a constant this page made up.
    let expiresAt = Infinity;

    try {
      const minted = await deviceLink.mintSiteCode(wallet);
      siteToken = minted.pairingToken;
      expiresAt = Math.min(expiresAt, minted.expiresAt);
      state.siteDevices = minted.devices;
      setScope(dom.siteDot, dom.siteNote, 'ready',
        'Your watchlist and holdings, read-only. Trading still needs a wallet on the phone.');
    } catch (err) {
      setScope(dom.siteDot, dom.siteNote, 'error', err.message || 'Could not create a code');
    }

    state.minting = false;
    dom.refresh.disabled = false;
    dom.regen.disabled = false;

    // The account changed while this code was being signed: it belongs to the old wallet
    if (wallet.connected && wallet.address !== forAddress) {
      mint();
      return;
    }
    state.mintedFor = forAddress;

    if (!siteToken) {
      dom.qrFrame.dataset.loading = 'false';
      dom.veilText.textContent = 'Could not create a code';
      dom.veil.hidden = false;
      dom.countdown.textContent = '';
      renderDevices();
      return;
    }

    state.linkUrl = deviceLink.buildLinkUrl(window.location.origin, siteToken);
    state.expiresAt = Number.isFinite(expiresAt) ? expiresAt : deviceLink.deadlineFrom(null);
    dom.veilText.textContent = 'Code expired';
    renderQr(state.linkUrl);
    dom.manualUrl.textContent = state.linkUrl;
    dom.manual.hidden = false;
    dom.regen.hidden = false;
    startCountdown();
    renderDevices();
  }

  // ------------------------------------------------------------------------- the connected phones

  function deviceRow(device) {
    const row = document.createElement('div');
    row.className = 'dl-device';

    const icon = document.createElement('span');
    icon.className = 'dl-device-icon';
    icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';

    const body = document.createElement('div');
    body.className = 'dl-device-body';

    const name = document.createElement('span');
    name.className = 'dl-device-name';
    // textContent, never innerHTML: userAgent is a string the phone chose.
    name.textContent = deviceLink.describeDevice(device.userAgent);

    const meta = document.createElement('span');
    meta.className = 'dl-device-meta';
    const when = document.createElement('span');
    // The server records when a phone was linked, not when it was last used, so say that
    const linked = device.activatedAt || device.createdAt;
    when.textContent = linked ? `Linked ${deviceLink.timeAgo(linked)}` : 'Linked';
    meta.appendChild(when);

    body.appendChild(name);
    body.appendChild(meta);

    const revoke = document.createElement('button');
    revoke.className = 'dl-linkish dl-danger';
    revoke.type = 'button';
    revoke.textContent = 'Disconnect';
    revoke.onclick = () => revokeOne(device, revoke);

    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(revoke);
    return row;
  }

  function renderDevices() {
    const rows = state.siteDevices;

    dom.devices.hidden = false;
    dom.deviceList.replaceChildren();

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'dl-empty';
      empty.textContent = 'No phones connected yet.';
      dom.deviceList.appendChild(empty);
      dom.revokeAll.hidden = true;
      return;
    }

    rows.forEach((device) => dom.deviceList.appendChild(deviceRow(device)));
    dom.revokeAll.hidden = rows.length < 2;
  }

  async function revokeOne(device, button) {
    button.disabled = true;
    button.textContent = 'Disconnecting…';
    try {
      await deviceLink.revokeSiteDevice(wallet, device.id);
      state.siteDevices = state.siteDevices.filter((d) => d.id !== device.id);
      toast.success('Phone disconnected');
      renderDevices();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Disconnect';
      toast.error(err.message || 'Could not disconnect');
    }
  }

  async function revokeAll() {
    dom.revokeAll.disabled = true;
    try {
      if (state.siteDevices.length > 0) {
        await deviceLink.revokeSiteDevice(wallet, null);
        state.siteDevices = [];
      }
      toast.success('All phones disconnected');
    } catch (err) {
      toast.error(err.message || 'Could not disconnect everything');
    }
    dom.revokeAll.disabled = false;
    renderDevices();
  }

  // ----------------------------------------------------------------------------------- wiring up

  function showGate() {
    stopCountdown();
    dom.gate.hidden = false;
    dom.main.hidden = true;
    dom.devices.hidden = true;
  }

  function showMain() {
    dom.gate.hidden = true;
    dom.main.hidden = false;
    mint();
  }

  dom.gateBtn.onclick = () => wallet.connect();
  dom.refresh.onclick = () => mint();
  dom.regen.onclick = () => mint();
  dom.revokeAll.onclick = () => revokeAll();
  dom.copy.onclick = async () => {
    if (!state.linkUrl) return;
    // copyToClipboard raises its own toast, so this only has to move the button's own label.
    const ok = await utils.copyToClipboard(state.linkUrl);
    dom.copy.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { dom.copy.textContent = 'Copy'; }, 1800);
  };

  /**
   * Nothing here is worth doing while the tab is in the background: the countdown would keep
   * running against a code nobody can see, and browsers throttle the interval anyway. Recompute
   * on return instead of trusting the ticks that did or did not happen.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.linkUrl) return;
    if (Date.now() >= state.expiresAt) expire();
  });

  function boot() {
    if (wallet.connected && wallet.address) showMain();
    else showGate();
  }

  /**
   * wallet.js reconnects a remembered wallet asynchronously and announces the outcome with
   * `walletReady`. Booting on that rather than on DOMContentLoaded is what stops the page
   * flashing "connect a wallet" at somebody who already has one - and `initialized` covers the
   * race where init finished before this script ran.
   */
  if (wallet.initialized) boot();
  else window.addEventListener('walletReady', boot, { once: true });

  window.addEventListener('walletConnected', () => {
    if (dom.main.hidden) { showMain(); return; }
    // Phantom's accountChanged arrives as walletConnected with the page already showing a code:
    // that code and device list belong to the previous wallet, so a phone scanning it would be
    // paired to an account no longer shown here. Drop both and sign a fresh code.
    if (!state.minting && wallet.address !== state.mintedFor) {
      expire();
      state.siteDevices = [];
      renderDevices();
      mint();
    }
  });
  window.addEventListener('walletDisconnected', showGate);
})();
