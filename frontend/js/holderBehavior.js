// =============================================
// HolDEX — Holder Behavior Analysis
// Burn 10,000 ASDFASDFA â†’ analyze top 50 holders'
// avg hold time across all tokens (last 250 swaps)
// =============================================

(function () {
  'use strict';

  const BURN_MINT     = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
  const BURN_AMOUNT   = 10_000;
  const BURN_DECIMALS = 6;
  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  // ── Persisted access tokens (per mint, survives navigation) ──────────
  const STORAGE_KEY = 'hb_access';
  function loadTokens() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }
  function saveToken(mint, token) {
    try {
      const map = loadTokens();
      map[mint] = token;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {}
  }
  function getToken(mint) { return loadTokens()[mint] || null; }
  function clearToken(mint) {
    try {
      const map = loadTokens();
      delete map[mint];
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {}
  }

  // ── Pending burn recovery (survives tab close for 10 min) ────────────
  const PENDING_KEY = 'hb_pending_burn';
  function savePending(sig, mint, walletAddr, claimSignature) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ sig, mint, wallet: walletAddr, claimSignature, ts: Date.now() })); } catch {}
  }
  function clearPending() { try { sessionStorage.removeItem(PENDING_KEY); } catch {} }
  function getPending() {
    try {
      const d = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      if (!d || Date.now() - d.ts > 10 * 60 * 1000) { clearPending(); return null; }
      return d;
    } catch { return null; }
  }

  // ── Wallet ownership proofs (messages must match backend/src/routes/cultify.js) ──
  // A wallet address is public, so the backend only grants whitelist or burn access for one
  // with a signature.

  const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Encode(bytes) {
    let n = 0n;
    for (const b of bytes) n = n * 256n + BigInt(b);
    let out = '';
    while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
  }

  async function signBase64(message) {
    const { signature } = await wallet.signMessage(message);
    let binary = '';
    for (const b of signature) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  // Binds a burn to the token it pays for, so nobody else can claim it first
  function signBurnClaim(burnSignature, mint, walletAddress) {
    return signBase64(`HolDEX Holder Behavior Burn Claim: ${burnSignature} for ${mint} by ${walletAddress}`);
  }

  // Proves the connected wallet is ours (whitelisted, or a burn on record); returns query params
  async function signAccessProof(mint, walletAddress) {
    const ts = Date.now();
    const sig = await signBase64(`HolDEX Holder Behavior Access: ${mint} for ${walletAddress} at ${ts}`);
    return `&sig=${encodeURIComponent(sig)}&sigTs=${ts}`;
  }

  // ── Utilities ─────────────────────────────────────────────────────────
  function escHtml(str) {
    return typeof utils !== 'undefined'
      ? utils.escapeHtml(str)
      : String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function baseUrl() { return (typeof config !== 'undefined' && config.api?.baseUrl) || ''; }
  function walletAddr() { return (typeof wallet !== 'undefined' && wallet.connected) ? wallet.address : null; }
  function shortAddr(addr) { return addr ? addr.slice(0, 5) + '...' + addr.slice(-4) : '???'; }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '< 1m';
    const days  = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    if (days >= 1)  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours >= 1) return mins  > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
  }
  function formatTs(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Resolve token name/symbol from whichever page context we're on
  function getTokenInfo() {
    if (typeof tokenDetail !== 'undefined' && tokenDetail.token) {
      return { name: tokenDetail.token.name || null, symbol: tokenDetail.token.symbol || null };
    }
    // Cultify page: read from the preview card DOM
    const nameEl   = document.querySelector('.cultify-preview-name');
    const tickerEl = document.querySelector('.cultify-preview-ticker');
    if (nameEl || tickerEl) {
      return { name: nameEl?.textContent?.trim() || null, symbol: tickerEl?.textContent?.trim() || null };
    }
    return { name: null, symbol: null };
  }

  function buildShareText(tokenInfo, data) {
    const ticker  = tokenInfo.symbol ? `$${tokenInfo.symbol.toUpperCase()}` : (tokenInfo.name || 'Token');
    const avgHold = data.overallAvgHoldTimeMs ? formatDuration(data.overallAvgHoldTimeMs) : '—';
    return [
      `${ticker} Holder Behavior Analysis`,
      `────────────────────`,
      `Holders analyzed: ${data.analyzedCount}/${data.holderCount}`,
      `Swaps analyzed: ${(data.totalSwapsAnalyzed || 0).toLocaleString()}`,
      `Overall avg hold: ${avgHold}`,
      ``,
      `holdex.live`,
    ].join('\n');
  }

  async function handleShare(tokenInfo, data) {
    // On the token detail page — delegate to tokenDetail for the combined screenshot
    // (diamond hands + holder behavior in one image, matching the DH share button)
    if (typeof tokenDetail !== 'undefined' && typeof tokenDetail.shareWithHBData === 'function') {
      return tokenDetail.shareWithHBData(data);
    }

    // Cultify page fallback — plain text share / clipboard copy
    const ticker = tokenInfo.symbol ? `$${tokenInfo.symbol.toUpperCase()}` : (tokenInfo.name || 'Token');
    const text   = buildShareText(tokenInfo, data);

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `${ticker} Holder Behavior — HolDEX`, text, url: 'https://holdex.live' });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    // Clipboard fallback
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('hb-share-btn');
      if (btn) {
        const orig = btn.innerHTML;
        btn.textContent = 'Copied!';
        btn.classList.add('is-good');
        setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('is-good'); }, 2000);
      }
    } catch {}
  }

  // ── Modal ─────────────────────────────────────────────────────────────
  let pollTimer  = null;
  let pollStart  = null;

  function openModal(html) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'hb-overlay';
    overlay.id = 'hb-overlay';
    overlay.innerHTML = `
      <div class="hb-modal" id="hb-modal" role="dialog" aria-modal="true">
        <button class="hb-modal-close" id="hb-modal-close" aria-label="Close">&times;</button>
        <div id="hb-modal-body">${html}</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
    document.getElementById('hb-modal-close').addEventListener('click', closeModal);
    requestAnimationFrame(() => overlay.classList.add('hb-overlay--visible'));
  }

  function setBody(html) {
    const el = document.getElementById('hb-modal-body');
    if (el) el.innerHTML = html;
  }

  function isOpen() { return !!document.getElementById('hb-overlay'); }

  function closeModal() {
    stopPolling();
    const overlay = document.getElementById('hb-overlay');
    if (overlay) overlay.remove();
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  // Shared computing spinner — used in multiple places
  function computingHtml(title, sub) {
    return `<div class="hb-computing">
      <div class="hb-computing-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <p class="hb-computing-title">${escHtml(title)}</p>
      ${sub ? `<p class="hb-computing-sub" id="hb-computing-sub">${escHtml(sub)}</p>` : ''}
      <p class="hb-elapsed" id="hb-elapsed"></p>
      <div class="hb-progress-dots"><span></span><span></span><span></span></div>
    </div>`;
  }

  function errorHtml(msg) {
    return `<div class="hb-error-state">
      <p class="cultify-error">${escHtml(msg)}</p>
      <button class="cultify-burn-btn" id="hb-err-close">Close</button>
    </div>`;
  }

  function bindErrClose() {
    document.getElementById('hb-err-close')?.addEventListener('click', closeModal);
  }

  // ── Burn gate ─────────────────────────────────────────────────────────
  // Mint whose burn gate is showing. One page-level walletConnected listener handles it:
  // per-render listeners piled up, and together with the Connect button's own re-render they
  // bound two burn handlers to one button (one click, two burn prompts).
  // Connecting from the gate runs the access check again (a whitelisted wallet, or one that
  // already burned, should not be asked to burn). An account change on a connected gate
  // (Phantom accountChanged dispatches walletConnected) re-renders it, so balance and token
  // account match the new wallet, but never during an in-flight burn.
  let burnGateMint = null;
  let burnGateAddress = null; // wallet address the showing gate was rendered for
  window.addEventListener('walletConnected', () => {
    if (!burnGateMint) return;
    if (document.getElementById('hb-connect-btn')) { handleAnalyzeClick(burnGateMint); return; }
    const accountChanged = document.getElementById('hb-burn-btn') && !burnInProgress &&
      typeof wallet !== 'undefined' && wallet.address !== burnGateAddress;
    if (accountChanged) handleAnalyzeClick(burnGateMint);
  });

  async function showBurnGate(mint) {
    burnGateMint = mint;
    const connected = typeof wallet !== 'undefined' && wallet.connected;
    const gateAddress = connected ? wallet.address : null;
    burnGateAddress = gateAddress;

    let html = `
      <div class="hb-section-title">Holder Behavior Analysis</div>
      <p class="hb-desc">Analyze top 50 holders' avg hold time across all tokens using their last 200 swaps each.</p>
      <div class="hb-cost-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="url(#hbGateFlame)">
          <defs><linearGradient id="hbGateFlame" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#3b82f6"/>
          </linearGradient></defs>
          <path d="M12 23c-4.97 0-8-3.03-8-7 0-2.22.98-4.12 2.5-5.5C5.5 8 5 5.5 7 3c1 2 3 3.5 5 4 0-2 1-4 3-6 .5 2 1 4 1 6 2-1 3.5-2.5 4-4 0 3-1 5.5-2.5 7.5C19.02 11.88 20 13.78 20 16c0 3.97-3.03 7-8 7z"/>
        </svg>
        <strong>10,000 ASDFASDFA</strong> burn required
      </div>`;

    if (!connected) {
      html += `<button class="cultify-burn-btn" id="hb-connect-btn">Connect Wallet</button>`;
    } else {
      html += `
        <p class="hb-wallet-line">Wallet: ${escHtml(shortAddr(wallet.address))}</p>
        <p id="hb-balance-line" class="hb-balance-line">Loading balance...</p>
        <button class="cultify-burn-btn" id="hb-burn-btn" disabled>Burn &amp; Analyze</button>`;
    }
    html += `<div id="hb-burn-error"></div>`;

    openModal(html);

    if (!connected) {
      // Connecting dispatches walletConnected, which the listener above handles
      document.getElementById('hb-connect-btn').addEventListener('click', () => wallet.connect());
      return;
    }

    // Fetch balance
    const balData = await fetchBalance();

    // Re-grab elements — user may have closed modal while balance was loading
    const balEl  = document.getElementById('hb-balance-line');
    const burnBtn = document.getElementById('hb-burn-btn');
    if (!balEl || !burnBtn) return;
    if (burnGateAddress !== gateAddress) return; // gate re-rendered for another account meanwhile

    const required = BURN_AMOUNT * (10 ** BURN_DECIMALS);
    if (balData.balance <= 0 || !balData.tokenAccount) {
      balEl.textContent = 'ASDFASDFA balance: 0';
      balEl.classList.add('is-bad');
      const errEl = document.getElementById('hb-burn-error');
      if (errEl) errEl.innerHTML = '<p class="cultify-error">You don\'t hold any ASDFASDFA. Buy some first.</p>';
    } else if (balData.balance < required) {
      balEl.textContent = `ASDFASDFA balance: ${balData.uiBalance.toLocaleString()}`;
      balEl.classList.add('is-bad');
      const errEl = document.getElementById('hb-burn-error');
      if (errEl) errEl.innerHTML = `<p class="cultify-error">Need ${BURN_AMOUNT.toLocaleString()} ASDFASDFA. You have ${balData.uiBalance.toLocaleString()}.</p>`;
    } else {
      balEl.textContent = `ASDFASDFA balance: ${balData.uiBalance.toLocaleString()}`;
      balEl.classList.add('is-good');
      burnBtn.disabled = false;
    }

    // onclick, not addEventListener: a button can only ever hold one burn handler
    burnBtn.onclick = () => executeBurn(mint, balData.tokenAccount);
  }

  async function fetchBalance() {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const resp = await fetch(`${baseUrl()}/api/cultify/balance/${wallet.address}`, { signal: ac.signal });
      clearTimeout(t);
      if (!resp.ok) throw new Error('failed');
      return await resp.json();
    } catch { return { balance: 0, uiBalance: 0, tokenAccount: null }; }
  }

  // ── Burn transaction ──────────────────────────────────────────────────
  let burnInProgress = false;

  async function executeBurn(mint, tokenAccount) {
    if (burnInProgress) return; // never build a second burn while one is in flight
    burnInProgress = true;
    try {
      await runBurn(mint, tokenAccount);
    } finally {
      burnInProgress = false;
    }
  }

  async function runBurn(mint, tokenAccount) {
    // Grab UI elements now — they'll be replaced by setBody() later
    const burnBtn = document.getElementById('hb-burn-btn');
    if (!burnBtn) return;
    burnBtn.disabled = true;

    // Helper to update status text while still in the burn gate UI
    function setStatus(text) {
      if (document.getElementById('hb-burn-btn')) {
        burnBtn.textContent = text;
      }
    }
    // Helper to show error inside the burn gate (while it's still open)
    function showBurnError(msg) {
      const errEl = document.getElementById('hb-burn-error');
      if (errEl) {
        errEl.innerHTML = `<p class="cultify-error">${escHtml(msg)}</p>`;
        burnBtn.disabled = false;
        burnBtn.textContent = 'Burn & Analyze';
      } else {
        // Modal content was replaced; fall back to an error screen
        setBody(errorHtml(msg));
        bindErrClose();
      }
    }

    try {
      const { PublicKey, Transaction, TransactionInstruction } = solanaWeb3;

      // Pre-flight — verify backend reachable before touching the wallet
      setStatus('Checking backend...');
      const preflight = await fetch(`${baseUrl()}/api/cultify/blockhash`).catch(() => null);
      if (!preflight || !preflight.ok) {
        throw new Error('Backend unreachable. Burn aborted to protect your tokens.');
      }
      const { blockhash } = await preflight.json();

      // Build burn instruction
      setStatus('Approve in wallet...');
      const required = BigInt(BURN_AMOUNT) * BigInt(10 ** BURN_DECIMALS);
      const data = new Uint8Array(9);
      data[0] = 8; // SPL Token Burn opcode
      new DataView(data.buffer).setBigUint64(1, required, true);

      const ownerPk   = new PublicKey(wallet.address);
      const mintPk    = new PublicKey(BURN_MINT);
      const programPk = new PublicKey(TOKEN_PROGRAM_ID);
      const ataPk     = typeof tokenAccount === 'string' ? new PublicKey(tokenAccount) : tokenAccount;

      const burnIx = new TransactionInstruction({
        keys: [
          { pubkey: ataPk,   isSigner: false, isWritable: true },
          { pubkey: mintPk,  isSigner: false, isWritable: true },
          { pubkey: ownerPk, isSigner: true,  isWritable: false }
        ],
        programId: programPk,
        data
      });
      const tx = new Transaction().add(burnIx);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;

      const signed = await wallet.provider.signTransaction(tx);
      const serialized = signed.serialize();
      let binary = '';
      for (let i = 0; i < serialized.length; i++) binary += String.fromCharCode(serialized[i]);

      // Sign the claim for this burn BEFORE sending it (declining burns nothing).
      // The transaction id is its first signature.
      setStatus('Sign claim in wallet...');
      const claimSignature = await signBurnClaim(base58Encode(signed.signatures[0].signature), mint, wallet.address);

      // Send
      setStatus('Sending...');
      const sendResp = await fetch(`${baseUrl()}/api/cultify/send-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: btoa(binary) })
      });
      if (!sendResp.ok) {
        const e = await sendResp.json().catch(() => ({}));
        throw new Error(e.error || 'Failed to send transaction');
      }
      const { signature } = await sendResp.json();

      // Save pending immediately — protects against tab-close / network failure
      savePending(signature, mint, wallet.address, claimSignature);

      // Confirm
      setStatus('Confirming...');
      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const s = await fetch(`${baseUrl()}/api/cultify/tx-status/${signature}`);
          if (s.ok) {
            const sd = await s.json();
            if (sd.confirmed) {
              if (sd.failed) throw new Error('Burn transaction failed on-chain');
              confirmed = true;
              break;
            }
          }
        } catch (e) { if (e.message.includes('failed on-chain')) throw e; }
      }
      if (!confirmed) throw new Error('Confirmation is taking longer than expected. Reload the page to retry.');

      // Switch to computing spinner before verify so the user sees progress
      setBody(computingHtml('Verifying burn...', 'Confirming with the backend...'));
      pollStart = Date.now();

      // Verify
      const ok = await verifyBurnWithRetry(signature, mint, wallet.address, claimSignature);
      if (!ok) throw new Error('Verification failed. Reload the page to retry — your burn is safe.');

      // Start analysis
      setBody(computingHtml(
        'Burn verified! Analysis started...',
        'Analyzing 50 holders × 250 swaps each. This takes ~30–60 seconds.'
      ));
      pollStart = Date.now();
      startPolling(mint);

    } catch (err) {
      showBurnError(err.message);
    }
  }

  async function verifyBurnWithRetry(signature, mint, walletAddress, claimSignature) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      try {
        const resp = await fetch(`${baseUrl()}/api/cultify/holder-behavior/verify-burn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature, mint, wallet: walletAddress, claimSignature })
        });
        const data = await resp.json();

        if (resp.ok) {
          saveToken(mint, data.accessToken);
          clearPending();
          return true;
        }

        // 409 = claimed by something else. Our own earlier claim (a lost response) is answered
        // with a fresh token above, so only a token already stored for this mint still counts.
        if (resp.status === 409) {
          clearPending();
          const stored = getToken(mint);
          if (stored) {
            const checkResp = await fetch(
              `${baseUrl()}/api/cultify/holder-behavior/check-access/${encodeURIComponent(mint)}` +
              `?token=${encodeURIComponent(stored)}`
            ).catch(() => null);
            if (checkResp && checkResp.ok) {
              const checkData = await checkResp.json();
              if (checkData.access) return true;
            }
          }
          return false;
        }

        // 401 = claim not signed by the burning wallet — retrying the same claim won't help,
        // but keep the pending burn so it can be signed and claimed later
        if (resp.status === 401) return false;

        // 400 = bad transaction — don't retry
        if (resp.status === 400) { clearPending(); return false; }
        // 5xx / network — fall through to retry

      } catch {}
    }
    return false;
  }

  // ── Polling ───────────────────────────────────────────────────────────
  function startPolling(mint) {
    pollStart = Date.now();
    stopPolling(); // cancel any existing poll
    pollOnce(mint);
  }

  async function pollOnce(mint) {
    const token = getToken(mint);

    // Whitelisted wallets get a token from check-access too (after signing), so no token means
    // access has to be re-established: back through the access check, not straight to a burn
    if (!token) {
      showAccessLost(mint, 'Access token missing.');
      return;
    }

    const url = `${baseUrl()}/api/cultify/holder-behavior/analyze/${encodeURIComponent(mint)}` +
      `?token=${encodeURIComponent(token)}`;

    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      const resp = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      const data = await resp.json();

      if (!resp.ok) {
        // Expired access token — clear it and check access again (a whitelisted wallet or a
        // burn still on record can restore it by signing; otherwise this leads to the burn gate)
        if (resp.status === 403) {
          clearToken(mint);
          showAccessLost(mint, 'Access token expired.');
        } else {
          setBody(errorHtml(data.error || 'Analysis failed.'));
          bindErrClose();
        }
        return;
      }

      if (data.status === 'done') {
        clearPending();
        renderResults(data);
        showCachedNotice();
        return;
      }

      if (data.status === 'failed') {
        setBody(errorHtml(data.error || 'Analysis failed. Please try again.'));
        bindErrClose();
        return;
      }

      // Still computing — update elapsed time and check for overall timeout
      const elapsed = Math.round((Date.now() - (pollStart || Date.now())) / 1000);
      const elapsedEl = document.getElementById('hb-elapsed');
      if (elapsedEl) elapsedEl.textContent = `${elapsed}s elapsed`;

      // 5-minute hard timeout — prevents indefinite spinning if the backend job gets stuck
      if (elapsed >= 300) {
        setBody(errorHtml('Analysis is taking longer than expected. Your access is preserved — close this and try again later.'));
        bindErrClose();
        return;
      }

      pollTimer = setTimeout(() => pollOnce(mint), 5000);
    } catch {
      // Network error — keep polling (user may be on flaky connection)
      const elapsed = Math.round((Date.now() - (pollStart || Date.now())) / 1000);
      if (elapsed >= 300) {
        setBody(errorHtml('Analysis is taking longer than expected. Your access is preserved — close this and try again later.'));
        bindErrClose();
        return;
      }
      pollTimer = setTimeout(() => pollOnce(mint), 8000);
    }
  }

  // ── Results rendering ─────────────────────────────────────────────────
  function renderResults(data) {
    const { analyzedCount, holderCount, totalSwapsAnalyzed, overallAvgHoldTimeMs, holders = [], tokenStats = [] } = data;
    const tokenInfo = getTokenInfo();
    const ticker = tokenInfo.symbol ? tokenInfo.symbol.toUpperCase() : null;
    const displayName = ticker ? `$${ticker}` : (tokenInfo.name || null);

    const tickerHtml = displayName
      ? `<span class="hb-ticker-label">${escHtml(displayName)}</span>`
      : '';

    const summaryHtml = `
      <div class="hb-results-summary">
        <div class="hb-results-stat">
          <span class="hb-results-stat-value">${analyzedCount}/${holderCount}</span>
          <span class="hb-results-stat-label">Holders analyzed</span>
        </div>
        <div class="hb-results-stat">
          <span class="hb-results-stat-value">${(totalSwapsAnalyzed || 0).toLocaleString()}</span>
          <span class="hb-results-stat-label">Swaps analyzed</span>
        </div>
        <div class="hb-results-stat">
          <span class="hb-results-stat-value hb-avg-hold">${overallAvgHoldTimeMs ? formatDuration(overallAvgHoldTimeMs) : '—'}</span>
          <span class="hb-results-stat-label">Average Hold Time (all tokens)</span>
        </div>
      </div>`;

    const tabsHtml = `
      <div class="hb-tabs">
        <button class="hb-tab hb-tab--active" data-tab="holders">By Holder (${holders.length})</button>
        <button class="hb-tab" data-tab="tokens">By Token (${tokenStats.length})</button>
      </div>
      <div id="hb-tab-holders" class="hb-tab-content">
        ${renderHolderTab(holders)}
      </div>
      <div id="hb-tab-tokens" class="hb-tab-content" style="display:none">
        ${renderTokenTab(tokenStats)}
      </div>`;

    setBody(`
      <div class="hb-results-header">
        <div class="hb-results-header-left">
          <span class="hb-section-title">Holder Behavior</span>
          ${tickerHtml}
        </div>
        <button class="hb-share-btn" id="hb-share-btn" title="Share results">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          Share
        </button>
      </div>
      ${summaryHtml}
      ${tabsHtml}
      <div class="hb-watermark">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5"><polygon points="12,2 22,12 12,22 2,12"/></svg>
        holdex.live
      </div>
    `);

    // Share button
    document.getElementById('hb-share-btn')?.addEventListener('click', () => handleShare(tokenInfo, data));

    // Tab switching
    document.querySelectorAll('.hb-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.hb-tab').forEach(b => b.classList.remove('hb-tab--active'));
        btn.classList.add('hb-tab--active');
        const tab = btn.dataset.tab;
        document.getElementById('hb-tab-holders').style.display = tab === 'holders' ? '' : 'none';
        document.getElementById('hb-tab-tokens').style.display  = tab === 'tokens'  ? '' : 'none';
      });
    });

    // Expand/collapse holder pair rows
    document.querySelectorAll('.hb-holder-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const rank   = btn.dataset.rank;
        const detail = document.getElementById(`hb-pairs-${rank}`);
        if (!detail) return;
        const open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : '';
        btn.textContent = open ? '▶' : '▼';
      });
    });
  }

  function renderHolderTab(holders) {
    if (!holders || holders.length === 0) return '<p class="hb-empty">No holder data available.</p>';

    let html = `<div class="hb-table-wrap">
      <table class="hb-table">
        <thead><tr>
          <th scope="col">#</th><th scope="col">Address</th><th scope="col" class="text-right">Tokens</th>
          <th scope="col" class="text-right">Avg Hold</th><th scope="col" class="text-right">Swaps</th><th scope="col"></th>
        </tr></thead>
        <tbody>`;

    for (const h of holders) {
      const hasPairs = h.pairs && h.pairs.length > 0;
      html += `<tr class="hb-holder-row">
        <td>${h.rank}</td>
        <td class="hb-addr">${escHtml(shortAddr(h.address))}</td>
        <td class="text-right">${h.tokensTraded || 0}</td>
        <td class="text-right hb-hold-val">${h.avgHoldTimeMs ? formatDuration(h.avgHoldTimeMs) : '—'}</td>
        <td class="text-right hb-dim">${h.swapsAnalyzed || 0}</td>
        <td class="text-right">${hasPairs ? `<button class="hb-holder-toggle" data-rank="${h.rank}">▶</button>` : ''}</td>
      </tr>`;

      if (hasPairs) {
        html += `<tr id="hb-pairs-${h.rank}" class="hb-pairs-row" style="display:none">
          <td colspan="6">
            <div class="hb-pairs-wrap">
              <table class="hb-pairs-table">
                <thead><tr>
                  <th scope="col">Token</th><th scope="col">Type</th><th scope="col">Hold Time</th>
                  <th scope="col">Bought</th><th scope="col">Sold / Still Holding</th>
                </tr></thead>
                <tbody>
                  ${h.pairs.map(p => `
                    <tr>
                      <td class="hb-addr hb-mono">${escHtml(shortAddr(p.mint))}</td>
                      <td><span class="hb-type-badge hb-type-${p.type === 'sold' ? 'sold' : 'holding'}">${p.type === 'sold' ? 'Sold' : 'Holding'}</span></td>
                      <td class="hb-hold-val">${p.holdTime != null ? formatDuration(p.holdTime) : '<span class="hb-dim">—</span>'}</td>
                      <td class="hb-dim">${p.buyTime ? formatTs(p.buyTime) : '<span class="hb-dim">—</span>'}</td>
                      <td class="hb-dim">${p.sellTime ? formatTs(p.sellTime) : '<span class="hb-holding-now">still holding</span>'}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </td>
        </tr>`;
      }
    }

    html += '</tbody></table></div>';
    return html;
  }

  function renderTokenTab(tokenStats) {
    if (!tokenStats || tokenStats.length === 0) return '<p class="hb-empty">No token data available.</p>';

    let html = `<div class="hb-table-wrap">
      <table class="hb-table">
        <thead><tr>
          <th scope="col">Token</th><th scope="col" class="text-right">Holders</th><th scope="col" class="text-right">Pairs</th>
          <th scope="col" class="text-right">Avg Hold</th><th scope="col" class="text-right">Min</th><th scope="col" class="text-right">Max</th>
        </tr></thead>
        <tbody>`;

    for (const t of tokenStats) {
      html += `<tr>
        <td class="hb-addr hb-mono">${escHtml(shortAddr(t.mint))}</td>
        <td class="text-right">${t.holderCount}</td>
        <td class="text-right hb-dim">${t.pairCount}</td>
        <td class="text-right hb-hold-val">${formatDuration(t.avgHoldTimeMs)}</td>
        <td class="text-right hb-dim">${formatDuration(t.minHoldTimeMs)}</td>
        <td class="text-right hb-dim">${formatDuration(t.maxHoldTimeMs)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    return html;
  }

  // ── Card helpers ──────────────────────────────────────────────────────
  function showCachedNotice() {
    const notice = document.getElementById('hb-cached-notice');
    if (notice) notice.style.display = 'flex';
  }

  // Error screen with a button that runs the access check again (signing if needed, then the
  // burn gate only when the wallet has no whitelist entry or burn on record)
  function showAccessLost(mint, msg, label = 'Try Again') {
    setBody(errorHtml(msg));
    const errState = document.querySelector('.hb-error-state');
    if (errState) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'cultify-burn-btn';
      retryBtn.style.marginTop = '0.5rem';
      retryBtn.textContent = label;
      retryBtn.addEventListener('click', () => handleAnalyzeClick(mint));
      errState.appendChild(retryBtn);
    }
    bindErrClose();
  }

  // ── Main entry points ─────────────────────────────────────────────────
  function showChecking(text) {
    if (!isOpen()) openModal(computingHtml(text, null));
    else setBody(computingHtml(text, null));
  }

  function startResults(mint) {
    showChecking('Checking for results...');
    pollStart = Date.now();
    startPolling(mint);
  }

  let accessCheckInFlight = false;

  async function handleAnalyzeClick(mint) {
    if (accessCheckInFlight) return; // a double click must not ask for two signatures
    accessCheckInFlight = true;
    try {
      await checkAccessAndOpen(mint);
    } finally {
      accessCheckInFlight = false;
    }
  }

  async function checkAccessAndOpen(mint) {
    // 1. One access check: a stored token is enough; otherwise a whitelisted wallet, or one with
    //    a burn on record, gets a token once it proves it is ours by signing
    const token = getToken(mint);
    const wa = walletAddr();
    if (token || wa) {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (wa) params.set('wallet', wa);
      const checkUrl = `${baseUrl()}/api/cultify/holder-behavior/check-access/${encodeURIComponent(mint)}?${params}`;
      try {
        let resp = await fetch(checkUrl);
        let data = resp.ok ? await resp.json() : null;

        if (data && !data.access && data.reason === 'signature_required' && wa) {
          showChecking('Sign the message in your wallet to confirm it is yours...');
          let proof;
          try {
            proof = await signAccessProof(mint, wa);
          } catch {
            showAccessLost(mint, 'Signature declined. This wallet has access already: sign the message to use it.', 'Sign Again');
            return;
          }
          resp = await fetch(`${checkUrl}${proof}`);
          data = resp.ok ? await resp.json() : null;
        }

        if (data && data.access) {
          if (data.accessToken) saveToken(mint, data.accessToken);
          startResults(mint);
          return;
        }
      } catch {}
      // Token didn't work — fall through to burn gate (don't discard token yet,
      // the poll handler will clear it on 403)
    }

    // 2. Pending burn recovery
    const pending = getPending();
    if (pending && pending.mint === mint) {
      showChecking('Recovering previous burn...');
      // A burn saved before claims were signed: sign now if the burning wallet is connected
      let claimSignature = pending.claimSignature;
      if (!claimSignature && wa && wa === pending.wallet) {
        try { claimSignature = await signBurnClaim(pending.sig, pending.mint, pending.wallet); } catch {}
      }
      const ok = claimSignature
        ? await verifyBurnWithRetry(pending.sig, pending.mint, pending.wallet, claimSignature)
        : false;
      if (ok) {
        setBody(computingHtml('Burn recovered! Starting analysis...', null));
        pollStart = Date.now();
        startPolling(mint);
      } else {
        setBody(errorHtml(claimSignature
          ? 'Could not verify your previous burn.'
          : 'Could not verify your previous burn. Connect the wallet that made it, then retry.'));
        const errState = document.querySelector('.hb-error-state');
        if (errState) {
          if (getPending()) {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'cultify-burn-btn';
            retryBtn.style.marginTop = '0.5rem';
            retryBtn.textContent = 'Retry Verification';
            retryBtn.addEventListener('click', () => handleAnalyzeClick(mint));
            errState.appendChild(retryBtn);
          }
          const reburnBtn = document.createElement('button');
          reburnBtn.className = 'cultify-burn-btn';
          reburnBtn.style.marginTop = '0.5rem';
          reburnBtn.textContent = 'Burn Again';
          reburnBtn.addEventListener('click', () => showBurnGate(mint));
          errState.appendChild(reburnBtn);
        }
        bindErrClose();
      }
      return;
    }

    // 3. No access — show burn gate
    showBurnGate(mint);
  }

  // ── Initialization ────────────────────────────────────────────────────
  function init() {
    const analyzeBtn = document.getElementById('hb-analyze-btn');
    if (!analyzeBtn) return; // Not on token page

    function getMint() {
      return (typeof tokenDetail !== 'undefined' && tokenDetail.mint) ||
             new URLSearchParams(window.location.search).get('mint');
    }

    analyzeBtn.addEventListener('click', () => {
      const mint = getMint();
      if (mint) handleAnalyzeClick(mint);
    });

    // "View" button: only attached once, here in init()
    document.getElementById('hb-view-btn')?.addEventListener('click', () => {
      const mint = getMint();
      if (!mint) return;
      if (isOpen()) return; // already open
      if (!getToken(mint)) { handleAnalyzeClick(mint); return; }
      openModal(computingHtml('Loading results...', null));
      pollStart = Date.now();
      startPolling(mint);
    });

    // Show cached notice if we already have an access token for this mint
    function checkNotice() {
      const mint = getMint();
      if (mint && getToken(mint)) showCachedNotice();
    }

    if (getMint()) {
      checkNotice();
    } else {
      // tokenDetail.mint is set asynchronously; observe DOM until it appears
      const observer = new MutationObserver(() => {
        if (getMint()) { observer.disconnect(); checkNotice(); }
      });
      observer.observe(document.getElementById('token-content') || document.body, {
        childList: true, subtree: true
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());

