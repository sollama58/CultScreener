// =============================================
// HolDEX — Cultify Page Controller
// Analyze any token's holders via burn-gated access
// =============================================

(function () {
  'use strict';

  const BURN_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
  const BURN_AMOUNT = 5_000;
  const BURN_DECIMALS = 6;
  const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // SPL Token program ID
  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  // Access token from verify-burn (prevents wallet spoofing on analyze endpoint)
  // Persisted to localStorage so page reloads don't force a re-burn within the 12h window.
  // Tokens are per mint: currentAccessToken is always the one for the mint being viewed.
  let currentAccessToken = null;
  const memoryAccessTokens = {}; // per-mint copy for when localStorage is unavailable

  function _saveAccessToken(mint, token) {
    if (token && mint) memoryAccessTokens[mint] = token;
    try { if (token && mint) localStorage.setItem(`cultify-access-${mint}`, token); } catch (_) {}
  }
  function _loadAccessToken(mint) {
    let stored = null;
    try { stored = mint ? localStorage.getItem(`cultify-access-${mint}`) : null; } catch (_) {}
    return stored || (mint && memoryAccessTokens[mint]) || null;
  }
  function _clearAccessToken(mint) {
    if (mint) delete memoryAccessTokens[mint];
    try { if (mint) localStorage.removeItem(`cultify-access-${mint}`); } catch (_) {}
  }

  // ── Wallet ownership proofs (messages must match backend/src/routes/cultify.js) ──
  // A wallet address is public, so the backend only grants access for one with a signature.

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
    return signBase64(`HolDEX Cultify Burn Claim: ${burnSignature} for ${mint} by ${walletAddress}`);
  }

  // Proves a burn on record is ours when the access token was lost; returns query params
  async function signAccessProof(mint, walletAddress) {
    const ts = Date.now();
    const sig = await signBase64(`HolDEX Cultify Access: ${mint} for ${walletAddress} at ${ts}`);
    return `&sig=${encodeURIComponent(sig)}&sigTs=${ts}`;
  }

  const statusEl = document.getElementById('cultify-status');
  const resultsEl = document.getElementById('cultify-results');
  const previewEl = document.getElementById('cultify-preview');
  const mintInput = document.getElementById('cultify-mint');
  const goBtn = document.getElementById('cultify-go');

  // Cached token metadata for the current preview
  let previewData = null;
  let previewAbort = null;
  let previewTimer = null;
  let lastPreviewMint = null;

  // DexScreener metadata per mint, shared by the preview and the My Tokens list
  // ({ name, symbol, logo, pairCreatedAt, price, priceChange24h, ts }).
  const tokenMetaCache = new Map();
  const TOKEN_META_TTL = 5 * 60 * 1000;
  const DEXSCREENER_BATCH = 30; // /tokens/v1/solana/{a,b,c} takes up to 30 addresses

  function getCachedMeta(mint) {
    const meta = tokenMetaCache.get(mint);
    return meta && Date.now() - meta.ts < TOKEN_META_TTL ? meta : null;
  }

  // Build metadata for one mint from a DexScreener pairs array. In a batched response the
  // array holds pairs for several mints, so only this mint's pairs are considered.
  function metaFromPairs(pairs, mint, onlyOwnPairs) {
    if (!Array.isArray(pairs)) return null;
    const own = onlyOwnPairs
      ? pairs.filter(p => p?.baseToken?.address === mint || p?.quoteToken?.address === mint)
      : pairs;
    if (own.length === 0) return null;
    // The pair's priceUsd, priceChange and info belong to its base token, which is not
    // this mint when it trades as the quote (e.g. ZEC / TOKEN)
    const picked = utils.pickDexScreenerPair(own, mint);
    if (!picked) return null;
    const pair = picked.pair;
    const isBase = picked.side === 'base';
    const meta = {
      name: picked.token?.name || null,
      symbol: picked.token?.symbol || null,
      logo: (isBase ? utils.proxyImageUrl(pair.info?.imageUrl) : null) || null,
      pairCreatedAt: pair.pairCreatedAt || null,
      price: picked.priceUsd,
      priceChange24h: isBase && pair.priceChange?.h24 != null ? parseFloat(pair.priceChange.h24) : null,
      ts: Date.now(),
    };
    tokenMetaCache.set(mint, meta);
    return meta;
  }

  // ── Helpers ───────────────────────────────────────

  function showStatus(html) {
    statusEl.innerHTML = html;
    statusEl.classList.add('visible');
  }
  function hideStatus() {
    statusEl.innerHTML = '';
    statusEl.classList.remove('visible');
  }
  function showResults(html) {
    resultsEl.innerHTML = html;
    if (typeof utils !== 'undefined') utils.bindImageFallbacks(resultsEl);
    resultsEl.classList.add('visible');
  }
  function hideResults() {
    resultsEl.innerHTML = '';
    resultsEl.classList.remove('visible');
  }

  function escapeHtml(str) {
    return typeof utils !== 'undefined' ? utils.escapeHtml(str) : String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Token preview ─────────────────────────────────

  function showPreview(html) {
    previewEl.innerHTML = html;
    if (typeof utils !== 'undefined') utils.bindImageFallbacks(previewEl);
    previewEl.classList.add('visible');
  }
  function hidePreview() {
    previewEl.innerHTML = '';
    previewEl.classList.remove('visible');
    previewData = null;
    lastPreviewMint = null;
  }

  const defaultLogo = typeof utils !== 'undefined' ? utils.getDefaultLogo() :
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%2216%22 fill=%22%231c1c21%22/%3E%3Ctext x=%2216%22 y=%2221%22 text-anchor=%22middle%22 fill=%22%236b6b73%22 font-size=%2214%22%3E?%3C/text%3E%3C/svg%3E';

  async function fetchTokenPreview(mint) {
    // Cancel previous fetch
    if (previewAbort) previewAbort.abort();
    previewAbort = new AbortController();
    lastPreviewMint = mint;

    let meta = getCachedMeta(mint);
    if (!meta) showPreview('<div class="cultify-preview-loading">Loading token info...</div>');

    try {
      if (!meta) {
        const resp = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
          { signal: previewAbort.signal, headers: {} }
        );

        if (!resp.ok) throw new Error('not found');
        const pairs = await resp.json();
        meta = metaFromPairs(pairs, mint, false);
        if (!meta) throw new Error('not found');
      }

      const name = meta.name || 'Unknown';
      const symbol = meta.symbol || '???';
      const logo = meta.logo || defaultLogo;
      const { pairCreatedAt, price, priceChange24h } = meta;
      previewData = { name, symbol, logo, pairCreatedAt, price, priceChange24h };

      showPreview(`<div class="cultify-preview-card">
        <img class="cultify-preview-logo" src="${escapeHtml(logo)}" alt="" data-fallback="${escapeHtml(defaultLogo)}">
        <div class="cultify-preview-info">
          <div class="cultify-preview-name">${escapeHtml(name)}</div>
          <div class="cultify-preview-ticker">$${escapeHtml(symbol)}</div>
        </div>
      </div>`);
    } catch (err) {
      if (err.name === 'AbortError') return;
      lastPreviewMint = null; // allow a later retry of the same address
      // Couldn't load metadata — show minimal preview with just the address
      previewData = null;
      const short = mint.slice(0, 6) + '...' + mint.slice(-4);
      showPreview(`<div class="cultify-preview-card">
        <img class="cultify-preview-logo" src="${defaultLogo}" alt="">
        <div class="cultify-preview-info">
          <div class="cultify-preview-name">${short}</div>
          <div class="cultify-preview-ticker">Token not found on DexScreener</div>
        </div>
      </div>`);
    }
  }

  // Debounced (input and paste both fire for a paste, and typing matches the address
  // regex at several lengths); the same mint is not fetched twice in a row.
  function handleInputChange(immediate) {
    clearTimeout(previewTimer);
    const mint = mintInput.value.trim();
    if (SOLANA_ADDR_RE.test(mint)) {
      if (mint === lastPreviewMint) return;
      if (immediate === true) fetchTokenPreview(mint);
      else previewTimer = setTimeout(() => fetchTokenPreview(mint), 200);
    } else {
      hidePreview();
    }
  }

  // ── My analyzed tokens ─────────────────────────────

  const myTokensEl = document.getElementById('cultify-my-tokens');

  async function loadMyTokens() {
    if (typeof wallet === 'undefined' || !wallet.connected || !myTokensEl) return;

    const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
    try {
      const resp = await fetch(`${baseUrl}/api/cultify/my-tokens/${wallet.address}`);
      if (!resp.ok) return;
      const { tokens: rows } = await resp.json();
      if (!rows || rows.length === 0) {
        myTokensEl.classList.remove('visible');
        return;
      }

      // One row per mint (repeat burns return several), keeping the latest burn
      const byMint = new Map();
      rows.forEach(t => {
        const prev = byMint.get(t.mint);
        if (!prev || new Date(t.createdAt) > new Date(prev.createdAt)) byMint.set(t.mint, t);
      });
      const tokens = [...byMint.values()];

      // Fetch DexScreener metadata for mints not already known, up to 30 per request
      const missing = tokens.map(t => t.mint).filter(m => !getCachedMeta(m));
      const chunks = [];
      for (let i = 0; i < missing.length; i += DEXSCREENER_BATCH) chunks.push(missing.slice(i, i + DEXSCREENER_BATCH));
      await Promise.all(chunks.map(async (chunk) => {
        try {
          const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.map(encodeURIComponent).join(',')}`,
            { signal: AbortSignal.timeout(5000) });
          if (r.ok) {
            const pairs = await r.json();
            chunk.forEach(m => metaFromPairs(pairs, m, true));
          }
        } catch { /* skip */ }
      }));
      const metaMap = {};
      tokens.forEach(t => { const meta = getCachedMeta(t.mint); if (meta) metaMap[t.mint] = meta; });

      let html = '<div class="cultify-my-tokens-header">Your Analyzed Tokens (12hr access)</div>';
      html += '<div class="cultify-my-tokens-list">';
      tokens.forEach(t => {
        const meta = metaMap[t.mint] || {};
        const name = escapeHtml(meta.name || t.mint.slice(0, 6) + '...' + t.mint.slice(-4));
        const symbol = meta.symbol ? '$' + escapeHtml(meta.symbol) : '';
        const logo = meta.logo || defaultLogo;
        const short = t.mint.slice(0, 4) + '...' + t.mint.slice(-4);

        // Calculate time remaining
        const expiresAt = new Date(t.createdAt).getTime() + 12 * 60 * 60 * 1000;
        const remaining = expiresAt - Date.now();
        const hoursLeft = Math.max(0, Math.floor(remaining / 3600000));
        const minsLeft = Math.max(0, Math.floor((remaining % 3600000) / 60000));
        const timeStr = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m left` : `${minsLeft}m left`;

        html += `<div class="cultify-my-token" data-mint="${escapeHtml(t.mint)}">
          <img class="cultify-my-token-logo" src="${escapeHtml(logo)}" alt="" data-fallback="${escapeHtml(defaultLogo)}">
          <div class="cultify-my-token-info">
            <div class="cultify-my-token-name">${name} ${symbol ? '<span style="color:var(--text-dim);font-weight:500;">' + symbol + '</span>' : ''}</div>
            <div class="cultify-my-token-addr">${short}</div>
          </div>
          <div class="cultify-my-token-expires">${timeStr}</div>
        </div>`;
      });
      html += '</div>';

      myTokensEl.innerHTML = html;
      if (typeof utils !== 'undefined') utils.bindImageFallbacks(myTokensEl);
      myTokensEl.classList.add('visible');

      // Click to analyze
      myTokensEl.querySelectorAll('.cultify-my-token').forEach(el => {
        el.addEventListener('click', () => {
          const m = el.dataset.mint;
          mintInput.value = m;
          handleInputChange(true);
          handleCultify();
        });
      });
    } catch (err) {
      console.error('[Cultify] Failed to load my tokens:', err);
    }
  }

  // ── Poll lifecycle ────────────────────────────────
  // Each analysis/burn gate gets a run id; polls capture it and stop once a newer run
  // starts, so a previous mint's polls can neither keep going nor write into the new results.
  let runId = 0;
  function startNewRun() {
    runId++;
    if (diamondPollTimer) { clearTimeout(diamondPollTimer); diamondPollTimer = null; }
    if (analysisPollTimer) { clearTimeout(analysisPollTimer); analysisPollTimer = null; }
  }

  // Run fn now, or once the tab is visible again (polls pause in hidden tabs).
  function whenVisible(fn) {
    if (!document.hidden) { fn(); return; }
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      fn();
    };
    document.addEventListener('visibilitychange', onVisible);
  }

  // ── Main flow ─────────────────────────────────────

  async function handleCultify() {
    const mint = mintInput.value.trim();
    if (!SOLANA_ADDR_RE.test(mint)) {
      showStatus('<div class="cultify-gate"><p class="cultify-error">Please enter a valid Solana token address.</p></div>');
      hideResults();
      return;
    }

    goBtn.disabled = true;
    burnGateMint = null;
    startNewRun();
    hideResults();
    showStatus('<div class="cultify-gate"><p class="cultify-loading">Checking token...</p></div>');

    try {
      const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';

      // Step 1: Check access (pass both cache token and wallet for DB lookup)
      // Use this mint's token: a token left over from the previously viewed mint is useless here
      // and used to hide this mint's own stored token
      currentAccessToken = _loadAccessToken(mint);
      const walletAddr = (typeof wallet !== 'undefined' && wallet.connected) ? wallet.address : '';
      const tokenParam = currentAccessToken ? `&token=${currentAccessToken}` : '';
      const walletParam = walletAddr ? `&wallet=${walletAddr}` : '';
      const checkUrl = `${baseUrl}/api/cultify/check-access/${mint}?_=1${tokenParam}${walletParam}`;
      const checkResp = await fetch(checkUrl);
      let checkData = await checkResp.json();

      // This wallet has a burn on record for the token but our token is gone: sign to restore it
      if (!checkData.access && checkData.reason === 'signature_required' && walletAddr) {
        showStatus('<div class="cultify-gate"><p class="cultify-loading">You already burned for this token. Sign the message in your wallet to restore access...</p></div>');
        // The wallet has access; if signing or the signed check fails, offer to sign again
        // rather than falling through to the burn gate (which would ask for a second burn)
        let signedData = null;
        let failure = 'Signature declined.';
        let signed = false;
        try {
          const proof = await signAccessProof(mint, walletAddr);
          signed = true;
          const proofResp = await fetch(`${checkUrl}${proof}`);
          signedData = await proofResp.json();
          if (!signedData.access) failure = signFailureText(signedData);
        } catch {
          if (signed) failure = 'Could not reach the server to check your signature.';
        }
        // A plain 'none' means the burn's window closed meanwhile: that one is the burn gate
        if (!signedData || (!signedData.access && signedData.reason !== 'none')) {
          showSignAgain(failure);
          return;
        }
        checkData = signedData;
      }

      if (checkData.access) {
        // Pick up fresh access token if one was issued (returning user within 12hr)
        if (checkData.accessToken) currentAccessToken = checkData.accessToken;
        // Always persist to localStorage so page reloads within the 12h window don't lose access
        if (currentAccessToken) _saveAccessToken(mint, currentAccessToken);
        // Free or already burned — go straight to analysis
        showStatus('<div class="cultify-gate"><p class="cultify-loading">Analyzing holders...</p></div>');
        await loadAnalysis(mint, checkData.reason === 'curated');
      } else {
        // Burn required
        showBurnGate(mint);
      }
    } catch (err) {
      showStatus(`<div class="cultify-gate"><p class="cultify-error">Error: ${escapeHtml(err.message)}</p></div>`);
    } finally {
      goBtn.disabled = false;
    }
  }

  // Why a signed access check was refused, in words (detail comes from check-access)
  function signFailureText(data) {
    switch (data && data.detail) {
      case 'expired': return 'The signature took too long and expired.';
      case 'future': return 'The signature was refused because your device clock is ahead. Check your clock.';
      case 'replayed': return 'That signature was already used.';
      case 'bad_signature': return 'The signature did not match this wallet.';
      default: return 'Your signature could not be checked.';
    }
  }

  // Shown when a wallet with a burn on record could not prove it is ours: never the burn gate,
  // which would charge a second burn for access the wallet already has
  function showSignAgain(reasonText) {
    let html = '<div class="cultify-gate">';
    html += '<h3>Signature Needed</h3>';
    html += `<p class="cultify-error">${escapeHtml(reasonText)}</p>`;
    html += '<p>This wallet already has access to this token. Sign the message in your wallet to restore it; no new burn is needed.</p>';
    html += '<button class="cultify-burn-btn" id="cultify-sign-again-btn">Sign again</button>';
    html += '</div>';
    showStatus(html);
    document.getElementById('cultify-sign-again-btn').addEventListener('click', () => handleCultify());
  }

  // ── Solana web3 (loaded on demand) ────────────────
  // Only the burn needs @solana/web3.js (~106 KB gzip), so it is not a page script:
  // prefetched when the burn gate opens for a connected wallet, awaited by executeBurn.
  let web3Promise = null;
  function loadWeb3() {
    if (typeof solanaWeb3 !== 'undefined') return Promise.resolve();
    if (!web3Promise) {
      web3Promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/@solana/web3.js@1.98.0/lib/index.iife.min.js';
        script.integrity = 'sha384-1/Ll6ABlJDlMx1URcif2stL9Fxod/1rg71YHzGqTl6Bwzi0Vq993Jt/oVLFXfUgQ';
        script.crossOrigin = 'anonymous';
        const fail = () => {
          web3Promise = null; // allow a retry on the next attempt
          script.remove();
          reject(new Error('Failed to load the Solana library. Check your connection and try again.'));
        };
        // A script that loads without defining the global (e.g. a proxy error page) is a failure too
        script.onload = () => (typeof solanaWeb3 !== 'undefined' ? resolve() : fail());
        script.onerror = fail;
        document.head.appendChild(script);
      });
    }
    return web3Promise;
  }

  // ── Burn gate UI ──────────────────────────────────

  // Fetch user's ASDFASDFA balance via backend (uses Helius RPC, keeps API key server-side)
  async function fetchBurnTokenBalance() {
    try {
      const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
      const resp = await fetch(`${baseUrl}/api/cultify/balance/${wallet.address}`);
      if (!resp.ok) throw new Error('Balance check failed');
      return await resp.json();
    } catch (err) {
      console.error('[Cultify] Failed to fetch ASDFASDFA balance:', err);
      return { balance: 0, uiBalance: 0, tokenAccount: null };
    }
  }

  // Mint whose burn gate is showing. One page-level walletConnected listener re-renders it:
  // per-render listeners piled up, and together with the Connect button's own re-render they
  // bound two burn handlers to one button (one click, two burn prompts).
  // It also re-renders a connected gate when the account changes (Phantom accountChanged
  // dispatches walletConnected), so balance and token account match the new wallet,
  // but never over results or an in-flight burn.
  let burnGateMint = null;
  let burnGateAddress = null; // wallet address the showing gate was rendered for
  window.addEventListener('walletConnected', () => {
    if (!burnGateMint) return;
    const accountChanged = document.getElementById('cultify-burn-btn') && !burnInProgress &&
      typeof wallet !== 'undefined' && wallet.address !== burnGateAddress;
    if (document.getElementById('cultify-connect-btn') || accountChanged) showBurnGate(burnGateMint);
  });

  async function showBurnGate(mint) {
    burnGateMint = mint;
    startNewRun();
    const connected = typeof wallet !== 'undefined' && wallet.connected;
    const gateAddress = connected ? wallet.address : null;
    burnGateAddress = gateAddress;

    let html = '<div class="cultify-gate">';
    html += '<h3>Burn Required</h3>';
    html += `<p>This token is not in the curated list. To analyze it, burn <span class="cultify-burn-cost">${BURN_AMOUNT.toLocaleString()} ASDFASDFA</span> tokens.</p>`;

    if (!connected) {
      html += '<button class="cultify-burn-btn" id="cultify-connect-btn">Connect Wallet</button>';
    } else {
      html += `<p style="font-size:0.75rem;color:var(--text-dim);margin-bottom:0.5rem;">Wallet: ${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}</p>`;
      html += '<p id="cultify-balance" style="font-size:0.78rem;color:var(--text-muted);margin-bottom:0.75rem;">Loading balance...</p>';
      html += '<button class="cultify-burn-btn" id="cultify-burn-btn" disabled>Burn & Analyze</button>';
    }

    html += '<div id="cultify-burn-error"></div>';
    html += '</div>';
    showStatus(html);

    if (!connected) {
      // Connecting dispatches walletConnected, which re-renders the gate (listener above)
      document.getElementById('cultify-connect-btn').addEventListener('click', () => wallet.connect());
    } else {
      loadWeb3().catch(() => {}); // prefetch for executeBurn
      // Fetch and display balance
      const balData = await fetchBurnTokenBalance();
      const balEl = document.getElementById('cultify-balance');
      const burnBtn = document.getElementById('cultify-burn-btn');
      if (!balEl || !burnBtn) return; // user navigated away
      if (burnGateAddress !== gateAddress) return; // gate re-rendered for another account meanwhile

      const required = BURN_AMOUNT * (10 ** BURN_DECIMALS);

      if (balData.balance <= 0 || !balData.tokenAccount) {
        balEl.textContent = 'Your ASDFASDFA balance: 0';
        balEl.style.color = '#ef4444';
        burnBtn.disabled = true;
        const errEl = document.getElementById('cultify-burn-error');
        if (errEl) errEl.innerHTML = '<p class="cultify-error">You don\'t hold any ASDFASDFA tokens. Buy some first.</p>';
      } else if (balData.balance < required) {
        balEl.textContent = `Your ASDFASDFA balance: ${balData.uiBalance.toLocaleString()}`;
        balEl.style.color = '#ef4444';
        burnBtn.disabled = true;
        const errEl = document.getElementById('cultify-burn-error');
        if (errEl) errEl.innerHTML = `<p class="cultify-error">Insufficient balance. You need ${BURN_AMOUNT.toLocaleString()} ASDFASDFA.</p>`;
      } else {
        balEl.textContent = `Your ASDFASDFA balance: ${balData.uiBalance.toLocaleString()}`;
        balEl.style.color = '#22c55e';
        burnBtn.disabled = false;
      }

      // onclick, not addEventListener: a button can only ever hold one burn handler
      burnBtn.onclick = () => executeBurn(mint, balData.tokenAccount);
    }
  }

  // ── Pending burn recovery ──────────────────────────
  // Saves burn signature to localStorage so if verification fails (backend down,
  // network error, tab closed), the user can recover without losing tokens.

  const PENDING_BURN_KEY = 'cultify_pending_burn';

  function savePendingBurn(signature, mint, walletAddress, claimSignature) {
    try {
      localStorage.setItem(PENDING_BURN_KEY, JSON.stringify({
        signature, mint, wallet: walletAddress, claimSignature, ts: Date.now()
      }));
    } catch { /* localStorage unavailable */ }
  }

  function clearPendingBurn() {
    try { localStorage.removeItem(PENDING_BURN_KEY); } catch {}
  }

  function getPendingBurn() {
    try {
      const raw = localStorage.getItem(PENDING_BURN_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 10 minutes (burn verification window)
      if (Date.now() - data.ts > 10 * 60 * 1000) {
        clearPendingBurn();
        return null;
      }
      return data;
    } catch { return null; }
  }

  // Try to verify a pending burn on page load
  async function recoverPendingBurn() {
    const pending = getPendingBurn();
    if (!pending) return;

    showStatus(`<div class="cultify-gate">
      <h3>Recovering Previous Burn</h3>
      <p class="cultify-loading">Found an unverified burn transaction. Verifying...</p>
    </div>`);

    // A burn saved before claims were signed: sign now if the burning wallet is connected
    let claimSignature = pending.claimSignature;
    if (!claimSignature && typeof wallet !== 'undefined' && wallet.connected && wallet.address === pending.wallet) {
      try { claimSignature = await signBurnClaim(pending.signature, pending.mint, pending.wallet); } catch (_) {}
    }

    const ok = claimSignature
      ? await verifyBurnWithRetry(pending.signature, pending.mint, pending.wallet, claimSignature)
      : false;
    if (ok) {
      mintInput.value = pending.mint;
      fetchTokenPreview(pending.mint);
      showStatus('<div class="cultify-gate"><p class="cultify-loading">Burn recovered! Analyzing holders...</p></div>');
      await loadAnalysis(pending.mint, false);
    } else {
      showStatus(`<div class="cultify-gate">
        <h3>Burn Recovery Failed</h3>
        <p class="cultify-error">Could not verify your burn.${claimSignature ? '' : ' Connect the wallet that made it, then retry.'} Your signature: <code style="font-size:0.7rem;word-break:break-all;">${escapeHtml(pending.signature)}</code></p>
        <button class="cultify-burn-btn" id="cultify-retry-btn" style="margin-top:0.75rem;">Retry Verification</button>
      </div>`);
      document.getElementById('cultify-retry-btn')?.addEventListener('click', () => recoverPendingBurn());
    }
  }

  // Verify burn with retries (up to 3 attempts with backoff)
  async function verifyBurnWithRetry(signature, mint, walletAddress, claimSignature) {
    const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));

        const resp = await fetch(`${baseUrl}/api/cultify/verify-burn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature, mint, wallet: walletAddress, claimSignature }),
        });

        const data = await resp.json();

        if (resp.ok) {
          currentAccessToken = data.accessToken;
          _saveAccessToken(mint, currentAccessToken);
          clearPendingBurn();
          return true;
        }

        // 409 = claimed by something else. Our own earlier claim (a lost response) is answered
        // with a fresh token above, so only a token already stored for this mint still counts.
        if (resp.status === 409) {
          clearPendingBurn();
          const stored = _loadAccessToken(mint);
          if (stored) {
            const checkResp = await fetch(`${baseUrl}/api/cultify/check-access/${mint}?token=${encodeURIComponent(stored)}`);
            const checkData = await checkResp.json();
            if (checkData.access) { currentAccessToken = stored; return true; }
          }
          return false;
        }

        // 401 = claim not signed by the burning wallet — retrying the same claim won't help,
        // but keep the pending burn so it can be signed and claimed later
        if (resp.status === 401) return false;

        // 400 = bad transaction (wrong mint, too old, etc.) — don't retry
        if (resp.status === 400) {
          clearPendingBurn();
          return false;
        }

        // 502/500 = backend error — retry
      } catch {
        // Network error — retry
      }
    }
    return false;
  }

  // ── Burn transaction ──────────────────────────────

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
    const burnBtn = document.getElementById('cultify-burn-btn');
    const errorEl = document.getElementById('cultify-burn-error');
    burnBtn.disabled = true;
    burnBtn.textContent = 'Preparing transaction...';
    errorEl.innerHTML = '';

    try {
      await loadWeb3();
      const { PublicKey, Transaction, TransactionInstruction } = solanaWeb3;
      const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';

      const ownerPubkey = new PublicKey(wallet.address);
      const mintPubkey = new PublicKey(BURN_MINT);
      const tokenProgramId = new PublicKey(TOKEN_PROGRAM_ID);

      if (!tokenAccount) {
        throw new Error('No ASDFASDFA token account found. Buy some first.');
      }

      // Step 1: Pre-flight check — make sure backend is reachable BEFORE burning tokens
      burnBtn.textContent = 'Checking backend...';
      const preflight = await fetch(`${baseUrl}/api/cultify/blockhash`).catch(() => null);
      if (!preflight || !preflight.ok) {
        throw new Error('Backend is unreachable. Burn aborted to protect your tokens. Try again later.');
      }
      const { blockhash } = await preflight.json();

      // Step 2: Build burn instruction
      burnBtn.textContent = 'Approve in wallet...';
      const required = BigInt(BURN_AMOUNT) * BigInt(10 ** BURN_DECIMALS);
      const data = new Uint8Array(9);
      data[0] = 8; // SPL Token Burn instruction index
      const view = new DataView(data.buffer);
      view.setBigUint64(1, required, true); // little-endian

      const tokenAccountPubkey = typeof tokenAccount === 'string'
        ? new PublicKey(tokenAccount) : tokenAccount;

      const burnIx = new TransactionInstruction({
        keys: [
          { pubkey: tokenAccountPubkey, isSigner: false, isWritable: true },
          { pubkey: mintPubkey, isSigner: false, isWritable: true },
          { pubkey: ownerPubkey, isSigner: true, isWritable: false },
        ],
        programId: tokenProgramId,
        data: data,
      });

      const tx = new Transaction().add(burnIx);
      tx.feePayer = ownerPubkey;
      tx.recentBlockhash = blockhash;

      // Step 3: Sign with wallet
      const signed = await wallet.provider.signTransaction(tx);
      const serialized = signed.serialize();
      let binary = '';
      for (let i = 0; i < serialized.length; i++) binary += String.fromCharCode(serialized[i]);
      const base64Tx = btoa(binary);

      // Step 3b: Sign the claim for this burn BEFORE sending it (declining burns nothing).
      // The transaction id is its first signature.
      burnBtn.textContent = 'Sign claim in wallet...';
      const txId = base58Encode(signed.signatures[0].signature);
      const claimSignature = await signBurnClaim(txId, mint, wallet.address);

      // Step 4: Send transaction via backend
      burnBtn.textContent = 'Sending transaction...';
      const sendResp = await fetch(`${baseUrl}/api/cultify/send-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: base64Tx }),
      });
      if (!sendResp.ok) {
        const sendErr = await sendResp.json().catch(() => ({}));
        throw new Error(sendErr.error || 'Failed to send transaction');
      }
      const { signature } = await sendResp.json();

      // Step 5: Save pending burn IMMEDIATELY after send — if anything fails from
      // here on, the user can recover by reloading the page
      savePendingBurn(signature, mint, wallet.address, claimSignature);

      // Step 6: Poll for confirmation
      burnBtn.textContent = 'Confirming burn...';
      // Back off 1, 2, 4, then every 5 s for up to ~60 s (it shares a per-IP rate limit)
      let confirmed = false;
      const confirmDeadline = Date.now() + 60000;
      for (let delay = 1000; Date.now() < confirmDeadline; delay = Math.min(delay * 2, 5000)) {
        await new Promise(r => setTimeout(r, delay));
        try {
          const statusResp = await fetch(`${baseUrl}/api/cultify/tx-status/${signature}`);
          if (statusResp.ok) {
            const statusData = await statusResp.json();
            if (statusData.confirmed) {
              if (statusData.failed) throw new Error('Burn transaction failed on-chain');
              confirmed = true;
              break;
            }
          }
        } catch (e) {
          // A failed transaction burned nothing: say so now and drop the pending burn,
          // rather than polling the same answer and reporting a slow confirmation
          if (e.message.includes('failed on-chain')) {
            clearPendingBurn();
            throw new Error('Burn transaction failed on-chain. No tokens were burned — please try again.');
          }
          /* network error — retry */
        }
      }
      if (!confirmed) {
        throw new Error('Confirmation is taking longer than expected. Your burn is saved — reload the page to retry verification.');
      }

      // Step 7: Verify burn with retries
      burnBtn.textContent = 'Verifying...';
      const verified = await verifyBurnWithRetry(signature, mint, wallet.address, claimSignature);
      if (!verified) {
        throw new Error('Burn verified on-chain but backend verification failed. Reload the page to retry — your burn is safe.');
      }

      // Success
      showStatus('<div class="cultify-gate"><p class="cultify-loading">Burn verified! Analyzing holders...</p></div>');
      await loadAnalysis(mint, false);

    } catch (err) {
      errorEl.innerHTML = `<p class="cultify-error">${escapeHtml(err.message)}</p>`;
      burnBtn.disabled = false;
      burnBtn.textContent = 'Burn & Analyze';
    }
  }

  // ── Load and render analysis ──────────────────────

  let analysisPollTimer = null;

  async function loadAnalysis(mint, isCurated) {
    const run = runId;
    try {
      const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
      const tokenParam = currentAccessToken ? `?token=${currentAccessToken}` : '';
      const url = `${baseUrl}/api/cultify/analyze/${mint}${tokenParam}`;
      const resp = await fetch(url);

      if (!resp.ok) {
        if (resp.status === 403) { currentAccessToken = null; _clearAccessToken(mint); }
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Analysis failed');
      }

      const data = await resp.json();
      if (run !== runId) return; // a newer analysis started meanwhile

      if (data.error === 'rpc_unavailable' || data.error === 'no_holders') {
        showStatus('<div class="cultify-gate"><p class="cultify-error">Holder data temporarily unavailable. Try again later.</p></div>');
        return;
      }

      hideStatus();
      renderResults(mint, data, isCurated);

      // The first response is fast but may lack enriched data (real holder count,
      // LP/burn flags). Poll a few times to get the worker-enriched result.
      if (!data.supply && !analysisPollTimer) {
        let enrichAttempt = 0;
        const pollEnriched = async () => {
          if (run !== runId) return; // superseded: leave the current run's timer alone
          analysisPollTimer = null;
          enrichAttempt++;
          if (enrichAttempt > 5) return; // give up after 5 attempts (~25s)
          try {
            const enrichedResp = await fetch(url);
            if (run !== runId) return;
            if (enrichedResp.ok) {
              const enriched = await enrichedResp.json();
              if (run !== runId) return;
              if (enriched.supply || (enriched.metrics && enriched.metrics.holderCount)) {
                updateEnrichedMetrics(enriched);
                return; // done
              }
            }
          } catch (_) {}
          // Not enriched yet — try again
          analysisPollTimer = setTimeout(() => whenVisible(pollEnriched), 5000);
        };
        analysisPollTimer = setTimeout(() => whenVisible(pollEnriched), 4000);
      }
    } catch (err) {
      if (run !== runId) return; // a stale analysis's error must not cover the newer run
      showStatus(`<div class="cultify-gate"><p class="cultify-error">${escapeHtml(err.message)}</p></div>`);
    }
  }

  function updateEnrichedMetrics(data) {
    // Fill the holders table's % column, which the fast response leaves as '--'
    if (Array.isArray(data.holders)) {
      data.holders.forEach(h => {
        if (h.percentage == null || !h.address) return;
        resultsEl.querySelectorAll('[data-holder-pct]').forEach(td => {
          if (td.dataset.holderPct === h.address) td.textContent = h.percentage.toFixed(2) + '%';
        });
      });
    }
    if (!data.metrics) return;
    // Update holder count by ID (fast and reliable)
    if (data.metrics.holderCount && data.metrics.holderCount > 0) {
      const el = document.getElementById('cultify-total-holders');
      if (el) el.textContent = data.metrics.holderCount.toLocaleString();
    }
    // Update concentration metrics with LP/burn-adjusted values
    const metricMap = {
      'Top 5 Holders': data.metrics.top5Pct,
      'Top 10 Holders': data.metrics.top10Pct,
      'Top 20 Holders': data.metrics.top20Pct
    };
    const labels = document.querySelectorAll('.holder-metric-label');
    labels.forEach(label => {
      const pct = metricMap[label.textContent];
      if (pct != null) {
        const valueEl = label.parentElement.querySelector('.holder-metric-value');
        if (valueEl) valueEl.textContent = pct.toFixed(1) + '%';
      }
    });
  }

  function renderResults(mint, data, isCurated) {
    const { metrics, holders } = data;
    const shortMint = mint.slice(0, 6) + '...' + mint.slice(-4);

    // Use preview data if available for a richer header
    const name = previewData?.name || 'Token Analysis';
    const symbol = previewData?.symbol || '';
    const logo = previewData?.logo || defaultLogo;

    // Token age from DexScreener pairCreatedAt
    const pairCreatedAt = previewData?.pairCreatedAt;
    const tokenAge = pairCreatedAt ? utils.formatAge(pairCreatedAt) : 'N/A';

    // Holder count — prefer enriched data, fall back to "loading..."
    const holderCountStr = (metrics && metrics.holderCount && metrics.holderCount > 0)
      ? metrics.holderCount.toLocaleString()
      : null;

    let html = '<div class="cultify-results-header">';
    html += `<img class="cultify-preview-logo" src="${escapeHtml(logo)}" alt="" data-fallback="${escapeHtml(defaultLogo)}" style="width:32px;height:32px;">`;
    html += `<span class="cultify-token-name">${escapeHtml(name)}</span>`;
    if (symbol) html += `<span class="cultify-preview-ticker">$${escapeHtml(symbol)}</span>`;
    html += `<span class="cultify-token-address">${escapeHtml(shortMint)}</span>`;
    if (isCurated) html += '<span class="cultify-free-badge">Curated - Free</span>';
    html += '</div>';

    // Conviction metrics section — uses same classes as token page
    html += '<section class="holders-section">';
    html += '<div class="holders-graphic" id="cultify-holders-graphic">';

    // Share button (top-right of the graphic, same style as token page)
    html += `<div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem;" id="cultify-share-wrap">
      <button class="holders-share-btn" id="cultify-share-btn" title="Share conviction metrics">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
          <polyline points="16 6 12 2 8 6"/>
          <line x1="12" y1="2" x2="12" y2="15"/>
        </svg>
      </button>
    </div>`;

    // Metrics grid — same as token page
    if (metrics) {
      html += '<div class="holders-metrics">';
      html += holderMetric('Total Holders', holderCountStr || '...', null, 'cultify-total-holders');
      html += holderMetric('Token Age', tokenAge);
      // Top percentage metrics only shown if populated (worker enriches with LP-excluded percentages)
      if (metrics.top5Pct != null) {
        html += holderMetric('Top 5 Holders', metrics.top5Pct.toFixed(1) + '%', metrics.top5Pct);
        html += holderMetric('Top 10 Holders', metrics.top10Pct.toFixed(1) + '%', metrics.top10Pct);
        html += holderMetric('Top 20 Holders', metrics.top20Pct.toFixed(1) + '%', metrics.top20Pct);
      }
      html += '</div>';
    }

    // Diamond Hands — uses same classes as token page
    html += '<div class="diamond-hands-section" id="diamond-hands-section">';
    html += '<div class="diamond-hands-header">';
    html += '<span class="diamond-hands-title">Diamond Hands</span>';
    html += '<span class="diamond-hands-sample" id="diamond-hands-sample">Analyzing holders...</span>';
    html += '</div>';
    html += '<div class="diamond-hands-bars" id="diamond-hands-bars">';
    const buckets = ['6h', '24h', '3d', '1w', '1m', '3m', '6m', '9m'];
    const labels = ['&gt;6h', '&gt;24h', '&gt;3d', '&gt;1w', '&gt;1m', '&gt;3m', '&gt;6m', '&gt;9m'];
    buckets.forEach((key, i) => {
      html += `<div class="diamond-bar" data-bucket="${key}">
        <span class="diamond-bar-label">${labels[i]}</span>
        <div class="diamond-bar-track"><div class="diamond-bar-fill dh-loading" id="dh-fill-${key}"></div></div>
        <span class="diamond-bar-pct" id="dh-pct-${key}">...</span>
      </div>`;
    });
    html += '</div>';

    // Watermark — same as token page
    html += `<div class="diamond-hands-footer">
      <span class="diamond-hands-watermark">
        <svg class="dh-watermark-flame" width="12" height="12" viewBox="0 0 24 24" fill="url(#dhFlameGradCultify)">
          <defs>
            <linearGradient id="dhFlameGradCultify" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stop-color="#3b82f6"/>
              <stop offset="100%" stop-color="#8b5cf6"/>
            </linearGradient>
          </defs>
          <polygon points="12,2 22,12 12,22 2,12"/>
        </svg>
        <span class="dh-watermark-text">HolDEX</span>
        <span class="dh-watermark-sep"></span>
        <span class="dh-watermark-powered">holdex.live</span>
      </span>
    </div>`;

    html += '</div>';
    html += '</div></section>';

    // Holders table — uses same classes as token page
    if (holders && holders.length > 0) {
      html += '<section class="holders-section" style="margin-top:1rem;">';
      html += '<div class="holders-header"><h2><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> Top Holders</h2></div>';
      html += '<div class="holders-table-wrap"><table class="holders-table">';
      html += '<thead><tr><th scope="col">#</th><th scope="col">Address</th><th scope="col" class="text-right">Balance</th><th scope="col" class="text-right">%</th></tr></thead>';
      html += '<tbody>';
      holders.forEach(h => {
        const addr = escapeHtml(h.address);
        const short = h.address.slice(0, 4) + '...' + h.address.slice(-4);
        const bal = h.balance >= 1e9 ? (h.balance / 1e9).toFixed(2) + 'B'
          : h.balance >= 1e6 ? (h.balance / 1e6).toFixed(2) + 'M'
          : h.balance >= 1e3 ? (h.balance / 1e3).toFixed(2) + 'K'
          : h.balance.toFixed(2);
        // The fast (not yet enriched) response has percentage: null; updateEnrichedMetrics fills it in
        const pct = h.percentage != null ? h.percentage.toFixed(2) + '%' : '--';
        html += `<tr>
          <td>${h.rank}</td>
          <td><a href="https://solscan.io/account/${addr}" target="_blank" rel="noopener" class="holder-address" title="${addr}">${short}</a></td>
          <td class="text-right mono">${bal}</td>
          <td class="text-right mono" data-holder-pct="${addr}">${pct}</td>
        </tr>`;
      });
      html += '</tbody></table></div></section>';
    }

    showResults(html);

    // Bind share button
    const shareBtn = document.getElementById('cultify-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', () => shareCultifyAnalytics(mint));

    // Start polling for diamond hands data. No fresh=true here: it evicts the shared
    // diamond-hands result the token page reads; only an explicit Retry asks for it.
    diamondPollCount = 0;
    diamondFreshRequested = false;
    pollDiamondHands(mint);
  }

  function holderMetric(label, value, concentrationPct, id) {
    let cls = '';
    if (concentrationPct != null) {
      cls = concentrationPct > 80 ? 'concentration-high' : concentrationPct > 50 ? 'concentration-medium' : 'concentration-low';
    }
    const idAttr = id ? ` id="${id}"` : '';
    return `<div class="holder-metric">
      <span class="holder-metric-label">${label}</span>
      <span class="holder-metric-value ${cls}"${idAttr}>${value}</span>
    </div>`;
  }

  // ── Share screenshot ───────────────────────────────

  async function shareCultifyAnalytics(mint) {
    const graphic = document.getElementById('cultify-holders-graphic');
    if (!graphic) return;

    const btn = document.getElementById('cultify-share-btn');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

    const injected = [];
    const hidden = [];

    const hideEl = (el) => {
      if (!el) return;
      el._prevDisplay = el.style.display;
      el.style.display = 'none';
      hidden.push(el);
    };
    const restoreAll = () => {
      hidden.forEach(el => { el.style.display = el._prevDisplay || ''; delete el._prevDisplay; });
      hidden.length = 0;
      injected.forEach(el => { if (el.parentNode) el.remove(); });
      injected.length = 0;
      graphic.style.padding = '';
    };

    try {
      // Dynamically load html2canvas
      if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
          script.integrity = 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H';
          script.crossOrigin = 'anonymous';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load screenshot library'));
          document.head.appendChild(script);
        });
      }

      const esc = escapeHtml;
      const tokenName = previewData?.name || '';
      const tokenSymbol = previewData?.symbol || '';
      const tokenPrice = previewData?.price ? utils.formatPrice(previewData.price, 6) : '';
      const priceChange = previewData?.priceChange24h;
      const priceChangeStr = typeof priceChange === 'number' ? `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%` : '';
      const priceColor = priceChange >= 0 ? '#10b981' : '#ef4444';

      // Pre-load logo as data URL to avoid CORS
      let logoDataUrl = '';
      const logoSrc = previewData?.logo || defaultLogo;
      if (logoSrc && !logoSrc.startsWith('data:')) {
        try {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
            img.src = logoSrc;
            setTimeout(resolve, 2000);
          });
          if (img.naturalWidth > 0) {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            try { logoDataUrl = c.toDataURL('image/png'); } catch (_) {}
          }
        } catch (_) {}
      }

      // Hide share button from screenshot
      hideEl(document.getElementById('cultify-share-wrap'));

      graphic.style.padding = '1.25rem';

      // Inject header: logo + name + price
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-bottom:0.85rem;margin-bottom:0.85rem;border-bottom:1px solid rgba(255,255,255,0.06);';
      header.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.6rem;">
          ${logoDataUrl ? `<img src="${logoDataUrl}" style="width:32px;height:32px;border-radius:50%;background:#161719;">` : ''}
          <div>
            <div style="font-size:1rem;font-weight:800;color:#f0f0f2;letter-spacing:-0.02em;line-height:1.2;">${esc(tokenName)}</div>
            <div style="font-size:0.7rem;font-family:'JetBrains Mono',monospace;color:#6b6b74;text-transform:uppercase;letter-spacing:0.04em;">${esc(tokenSymbol)}</div>
          </div>
        </div>
        <div style="text-align:right;">
          ${tokenPrice ? `<div style="font-size:1.1rem;font-weight:700;color:#f0f0f2;font-family:'JetBrains Mono',monospace;letter-spacing:-0.02em;">${esc(tokenPrice)}</div>` : ''}
          ${priceChangeStr ? `<div style="font-size:0.75rem;font-weight:600;color:${priceColor};font-family:'JetBrains Mono',monospace;">${esc(priceChangeStr)}</div>` : ''}
        </div>`;
      graphic.insertBefore(header, graphic.firstChild);
      injected.push(header);

      // Inject section title
      const sectionTitle = document.createElement('div');
      sectionTitle.style.cssText = 'font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#6b6b74;margin-bottom:0.6rem;';
      sectionTitle.textContent = 'CONVICTION METRICS';
      graphic.insertBefore(sectionTitle, header.nextSibling);
      injected.push(sectionTitle);

      // Show watermark for screenshot
      const watermark = graphic.querySelector('.diamond-hands-watermark');
      let watermarkWasHidden = false;
      if (watermark) {
        const cs = getComputedStyle(watermark);
        watermarkWasHidden = cs.display === 'none';
        if (watermarkWasHidden) watermark.style.display = 'inline-flex';
      }

      const canvas = await html2canvas(graphic, {
        backgroundColor: '#060607',
        scale: 2,
        allowTaint: true,
        logging: false,
      });

      if (watermark && watermarkWasHidden) watermark.style.display = '';
      restoreAll();

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png');
      });
      const filename = `${(tokenSymbol || tokenName || 'token').toLowerCase()}-conviction.png`;

      // Try native share (mobile)
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: 'image/png' });
        const shareData = { files: [file] };
        if (navigator.canShare(shareData)) {
          try { await navigator.share(shareData); } catch (e) { if (e.name !== 'AbortError') throw e; }
          return;
        }
      }

      // Fallback: copy to clipboard
      if (navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (typeof toast !== 'undefined') toast.success('Screenshot copied to clipboard!');
      } else {
        // Last fallback: download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (typeof toast !== 'undefined') toast.success('Screenshot downloaded!');
      }
    } catch (err) {
      console.error('[Cultify] Share error:', err.message);
      if (typeof toast !== 'undefined') toast.error('Failed to capture screenshot');
    } finally {
      restoreAll();
      const watermark = document.querySelector('#cultify-holders-graphic .diamond-hands-watermark');
      if (watermark) watermark.style.display = '';
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  }

  let diamondPollTimer = null;
  let diamondPollCount = 0;
  let diamondFreshRequested = false;
  let diamondCurrentMint = null; // for retry button
  const MAX_DIAMOND_POLLS_ACTIVE = 60;  // ~3 min at 3s — actively computing
  const MAX_DIAMOND_POLLS_QUEUED = 120; // ~10 min at 5s — waiting in queue

  async function pollDiamondHands(mint, run = runId) {
    // Stale check first: a superseded poll must not touch the current run's timer
    if (run !== runId) return;
    if (diamondPollTimer) clearTimeout(diamondPollTimer);
    diamondPollTimer = null;
    diamondCurrentMint = mint;
    diamondPollCount++;

    const sampleEl = document.getElementById('diamond-hands-sample');

    const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
    const params = new URLSearchParams();
    if (currentAccessToken) params.set('token', currentAccessToken);
    if (diamondFreshRequested) params.set('fresh', 'true');
    diamondFreshRequested = false;
    const qs = params.toString();

    try {
      const resp = await fetch(`${baseUrl}/api/cultify/diamond-hands/${mint}${qs ? '?' + qs : ''}`);
      if (run !== runId) return; // a newer analysis started meanwhile

      if (resp.status === 403) {
        currentAccessToken = null; _clearAccessToken(mint);
        if (sampleEl) sampleEl.textContent = 'Access expired. Re-analyze to refresh.';
        finalizeDiamondBars();
        return;
      }

      if (!resp.ok) {
        diamondPollTimer = setTimeout(() => whenVisible(() => pollDiamondHands(mint, run)), 5000);
        return;
      }

      const data = await resp.json();
      if (run !== runId) return;

      // Terminal: computed with no distribution
      if (data.computed && !data.distribution) {
        if (sampleEl) sampleEl.textContent = 'Diamond hands data unavailable.';
        finalizeDiamondBars();
        return;
      }

      // Terminal: fully computed
      if (data.computed && data.distribution) {
        updateDiamondBars(data.distribution);
        if (sampleEl) {
          sampleEl.textContent = data.holderCount
            ? `Sample of ${data.sampleSize} across all ${data.holderCount.toLocaleString()} holders`
            : `${data.analyzed} of ${data.sampleSize} holders analyzed`;
        }
        finalizeDiamondBars();
        return;
      }

      // ── Not yet computed — determine status from queue + progress ──
      const queuePos = data.queue?.position || 0;
      const queueTotal = data.queue?.total || 0;
      const isQueued = queuePos > 1;
      const hasProgress = data.analyzed > 0 && data.sampleSize > 0;

      // Update bars if we have partial distribution data
      if (data.distribution) {
        updateDiamondBars(data.distribution);
      }

      // Pick the right status message
      if (sampleEl) {
        if (isQueued && !hasProgress) {
          // Waiting behind other tokens
          sampleEl.textContent = `In queue: position ${queuePos} of ${queueTotal}`;
        } else if (hasProgress) {
          // Actively being analyzed (might also have queue position 1)
          sampleEl.textContent = `Analyzing... ${data.analyzed}/${data.sampleSize} holders`;
        } else if (queuePos === 1) {
          // First in queue, sample loading
          sampleEl.textContent = 'Fetching holder data...';
        } else {
          sampleEl.textContent = 'Starting analysis...';
        }
      }

      // Timeout check — use longer limit when queued
      const maxPolls = isQueued ? MAX_DIAMOND_POLLS_QUEUED : MAX_DIAMOND_POLLS_ACTIVE;
      if (diamondPollCount > maxPolls) {
        if (sampleEl) {
          sampleEl.innerHTML = data.distribution
            ? 'Analysis timed out — showing partial results. <button class="dh-retry-btn" id="dh-retry-cultify">Retry</button>'
            : 'Analysis timed out. <button class="dh-retry-btn" id="dh-retry-cultify">Retry</button>';
          document.getElementById('dh-retry-cultify')?.addEventListener('click', () => {
            diamondPollCount = 0;
            diamondFreshRequested = true;
            if (sampleEl) sampleEl.textContent = 'Retrying...';
            if (diamondCurrentMint) pollDiamondHands(diamondCurrentMint);
          });
        }
        finalizeDiamondBars();
        return;
      }

      // Poll again — slower when queued
      const pollDelay = isQueued ? 5000 : 3000;
      diamondPollTimer = setTimeout(() => whenVisible(() => pollDiamondHands(mint, run)), pollDelay);
    } catch {
      diamondPollTimer = setTimeout(() => whenVisible(() => pollDiamondHands(mint, run)), 5000);
    }
  }

  function updateDiamondBars(distribution) {
    const buckets = ['6h', '24h', '3d', '1w', '1m', '3m', '6m', '9m'];
    buckets.forEach(key => {
      const pct = distribution[key] || 0;
      const fillEl = document.getElementById(`dh-fill-${key}`);
      const pctEl = document.getElementById(`dh-pct-${key}`);
      if (fillEl) {
        fillEl.classList.remove('dh-loading');
        fillEl.style.width = pct + '%';
        fillEl.className = 'diamond-bar-fill' +
          (pct >= 50 ? ' dh-high' : pct >= 20 ? ' dh-mid' : ' dh-low');
      }
      if (pctEl) {
        pctEl.textContent = pct + '%';
        pctEl.classList.remove('dh-text-high', 'dh-text-mid', 'dh-text-low');
        if (pct >= 50) pctEl.classList.add('dh-text-high');
        else if (pct >= 20) pctEl.classList.add('dh-text-mid');
        else if (pct > 0) pctEl.classList.add('dh-text-low');
      }
    });
  }

  // Remove loading shimmers from any bars that haven't received data
  function finalizeDiamondBars() {
    const buckets = ['6h', '24h', '3d', '1w', '1m', '3m', '6m', '9m'];
    buckets.forEach(key => {
      const fillEl = document.getElementById(`dh-fill-${key}`);
      const pctEl = document.getElementById(`dh-pct-${key}`);
      if (fillEl && fillEl.classList.contains('dh-loading')) {
        fillEl.classList.remove('dh-loading');
        fillEl.style.width = '0%';
      }
      if (pctEl && pctEl.textContent === '...') {
        pctEl.textContent = '0%';
      }
    });
  }


  // ── Event listeners ───────────────────────────────

  goBtn.addEventListener('click', handleCultify);
  mintInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCultify();
  });

  // Show token preview when a valid CA is pasted or typed
  mintInput.addEventListener('input', handleInputChange);
  mintInput.addEventListener('paste', () => {
    // paste event fires before the value updates — defer to next tick
    setTimeout(handleInputChange, 0);
  });

  // On page load, recover any pending burns that failed verification
  recoverPendingBurn();

  // Load analyzed tokens list if wallet is connected
  loadMyTokens();
  window.addEventListener('walletConnected', () => loadMyTokens());

})();

