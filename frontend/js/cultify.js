// =============================================
// CultScreener — Cultify Page Controller
// Analyze any token's holders via burn-gated access
// =============================================

(function () {
  'use strict';

  const BURN_MINT = '9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump';
  const BURN_AMOUNT = 10_000;
  const BURN_DECIMALS = 6;
  const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // SPL Token program ID
  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  // Access token from verify-burn (prevents wallet spoofing on analyze endpoint)
  let currentAccessToken = null;

  const statusEl = document.getElementById('cultify-status');
  const resultsEl = document.getElementById('cultify-results');
  const previewEl = document.getElementById('cultify-preview');
  const mintInput = document.getElementById('cultify-mint');
  const goBtn = document.getElementById('cultify-go');

  // Cached token metadata for the current preview
  let previewData = null;
  let previewAbort = null;

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
    previewEl.classList.add('visible');
  }
  function hidePreview() {
    previewEl.innerHTML = '';
    previewEl.classList.remove('visible');
    previewData = null;
  }

  const defaultLogo = typeof utils !== 'undefined' ? utils.getDefaultLogo() :
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%2216%22 fill=%22%231c1c21%22/%3E%3Ctext x=%2216%22 y=%2221%22 text-anchor=%22middle%22 fill=%22%236b6b73%22 font-size=%2214%22%3E?%3C/text%3E%3C/svg%3E';

  async function fetchTokenPreview(mint) {
    // Cancel previous fetch
    if (previewAbort) previewAbort.abort();
    previewAbort = new AbortController();

    showPreview('<div class="cultify-preview-loading">Loading token info...</div>');

    try {
      const resp = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
        { signal: previewAbort.signal, headers: {} }
      );

      if (!resp.ok) throw new Error('not found');
      const pairs = await resp.json();
      if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('not found');

      const pair = pairs[0];
      const name = pair.baseToken?.name || 'Unknown';
      const symbol = pair.baseToken?.symbol || '???';
      const logo = pair.info?.imageUrl || defaultLogo;

      previewData = { name, symbol, logo };

      showPreview(`<div class="cultify-preview-card">
        <img class="cultify-preview-logo" src="${escapeHtml(logo)}" alt="" onerror="this.src='${defaultLogo}'">
        <div class="cultify-preview-info">
          <div class="cultify-preview-name">${escapeHtml(name)}</div>
          <div class="cultify-preview-ticker">$${escapeHtml(symbol)}</div>
        </div>
      </div>`);
    } catch (err) {
      if (err.name === 'AbortError') return;
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

  function handleInputChange() {
    const mint = mintInput.value.trim();
    if (SOLANA_ADDR_RE.test(mint)) {
      fetchTokenPreview(mint);
    } else {
      hidePreview();
    }
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
    hideResults();
    showStatus('<div class="cultify-gate"><p class="cultify-loading">Checking token...</p></div>');

    try {
      const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';

      // Step 1: Check access
      const tokenParam = currentAccessToken ? `&token=${currentAccessToken}` : '';
      const checkUrl = `${baseUrl}/api/cultify/check-access/${mint}?_=1${tokenParam}`;
      const checkResp = await fetch(checkUrl);
      const checkData = await checkResp.json();

      if (checkData.access) {
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

  async function showBurnGate(mint) {
    const connected = typeof wallet !== 'undefined' && wallet.connected;

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
      document.getElementById('cultify-connect-btn').addEventListener('click', async () => {
        await wallet.connect();
        if (wallet.connected) showBurnGate(mint);
      });
    } else {
      // Fetch and display balance
      const balData = await fetchBurnTokenBalance();
      const balEl = document.getElementById('cultify-balance');
      const burnBtn = document.getElementById('cultify-burn-btn');
      if (!balEl || !burnBtn) return; // user navigated away

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

      burnBtn.addEventListener('click', () => executeBurn(mint, balData.tokenAccount));
    }

    // Listen for wallet connection events
    window.addEventListener('walletConnected', () => showBurnGate(mint), { once: true });
  }

  // ── Pending burn recovery ──────────────────────────
  // Saves burn signature to localStorage so if verification fails (backend down,
  // network error, tab closed), the user can recover without losing tokens.

  const PENDING_BURN_KEY = 'cultify_pending_burn';

  function savePendingBurn(signature, mint, walletAddress) {
    try {
      localStorage.setItem(PENDING_BURN_KEY, JSON.stringify({
        signature, mint, wallet: walletAddress, ts: Date.now()
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

    const ok = await verifyBurnWithRetry(pending.signature, pending.mint, pending.wallet);
    if (ok) {
      mintInput.value = pending.mint;
      fetchTokenPreview(pending.mint);
      showStatus('<div class="cultify-gate"><p class="cultify-loading">Burn recovered! Analyzing holders...</p></div>');
      await loadAnalysis(pending.mint, false);
    } else {
      showStatus(`<div class="cultify-gate">
        <h3>Burn Recovery Failed</h3>
        <p class="cultify-error">Could not verify your burn. Your signature: <code style="font-size:0.7rem;word-break:break-all;">${escapeHtml(pending.signature)}</code></p>
        <button class="cultify-burn-btn" id="cultify-retry-btn" style="margin-top:0.75rem;">Retry Verification</button>
      </div>`);
      document.getElementById('cultify-retry-btn')?.addEventListener('click', () => recoverPendingBurn());
    }
  }

  // Verify burn with retries (up to 3 attempts with backoff)
  async function verifyBurnWithRetry(signature, mint, walletAddress) {
    const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));

        const resp = await fetch(`${baseUrl}/api/cultify/verify-burn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature, mint, wallet: walletAddress }),
        });

        const data = await resp.json();

        if (resp.ok) {
          currentAccessToken = data.accessToken;
          clearPendingBurn();
          return true;
        }

        // 409 = already claimed — that's fine, it means a previous attempt succeeded
        if (resp.status === 409) {
          clearPendingBurn();
          // Re-check access to get a fresh access token
          const checkResp = await fetch(`${baseUrl}/api/cultify/check-access/${mint}?token=${currentAccessToken || ''}`);
          const checkData = await checkResp.json();
          if (checkData.access) return true;
        }

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

  async function executeBurn(mint, tokenAccount) {
    const burnBtn = document.getElementById('cultify-burn-btn');
    const errorEl = document.getElementById('cultify-burn-error');
    burnBtn.disabled = true;
    burnBtn.textContent = 'Preparing transaction...';
    errorEl.innerHTML = '';

    try {
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
      savePendingBurn(signature, mint, wallet.address);

      // Step 6: Poll for confirmation
      burnBtn.textContent = 'Confirming burn...';
      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
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
        } catch { /* retry */ }
      }
      if (!confirmed) {
        throw new Error('Confirmation is taking longer than expected. Your burn is saved — reload the page to retry verification.');
      }

      // Step 7: Verify burn with retries
      burnBtn.textContent = 'Verifying...';
      const verified = await verifyBurnWithRetry(signature, mint, wallet.address);
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

  async function loadAnalysis(mint, isCurated) {
    try {
      const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
      const tokenParam = currentAccessToken ? `?token=${currentAccessToken}` : '';
      const url = `${baseUrl}/api/cultify/analyze/${mint}${tokenParam}`;
      const resp = await fetch(url);

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Analysis failed');
      }

      const data = await resp.json();

      if (data.error === 'rpc_unavailable' || data.error === 'no_holders') {
        showStatus('<div class="cultify-gate"><p class="cultify-error">Holder data temporarily unavailable. Try again later.</p></div>');
        return;
      }

      hideStatus();
      renderResults(mint, data, isCurated);
    } catch (err) {
      showStatus(`<div class="cultify-gate"><p class="cultify-error">${escapeHtml(err.message)}</p></div>`);
    }
  }

  function renderResults(mint, data, isCurated) {
    const { metrics, holders } = data;
    const shortMint = mint.slice(0, 6) + '...' + mint.slice(-4);

    // Use preview data if available for a richer header
    const name = previewData?.name || 'Token Analysis';
    const symbol = previewData?.symbol || '';
    const logo = previewData?.logo || defaultLogo;

    let html = '<div class="cultify-results-header">';
    html += `<img class="cultify-preview-logo" src="${escapeHtml(logo)}" alt="" onerror="this.src='${defaultLogo}'" style="width:32px;height:32px;">`;
    html += `<span class="cultify-token-name">${escapeHtml(name)}</span>`;
    if (symbol) html += `<span class="cultify-preview-ticker">$${escapeHtml(symbol)}</span>`;
    html += `<span class="cultify-token-address">${escapeHtml(shortMint)}</span>`;
    if (isCurated) html += '<span class="cultify-free-badge">Curated - Free</span>';
    html += '</div>';

    // Metrics
    if (metrics) {
      const safeRisk = ['high', 'medium', 'low'].includes(metrics.riskLevel) ? metrics.riskLevel : 'low';
      const riskColor = safeRisk === 'high' ? '#ef4444'
        : safeRisk === 'medium' ? 'var(--ember)' : '#22c55e';

      html += '<div class="cultify-metrics">';
      html += metricCard(metrics.top5Pct.toFixed(1) + '%', 'Top 5 Holders', metrics.top5Pct);
      html += metricCard(metrics.top10Pct.toFixed(1) + '%', 'Top 10 Holders', metrics.top10Pct);
      html += metricCard(metrics.top20Pct.toFixed(1) + '%', 'Top 20 Holders', metrics.top20Pct);
      html += `<div class="cultify-metric">
        <div class="cultify-metric-value" style="color:${riskColor}">${safeRisk.toUpperCase()}</div>
        <div class="cultify-metric-label">Risk Level</div>
      </div>`;
      html += '</div>';
    }

    // Holders table
    if (holders && holders.length > 0) {
      html += '<div class="cultify-holders-table"><table>';
      html += '<thead><tr><th>#</th><th>Address</th><th class="text-right">Balance</th><th class="text-right">%</th></tr></thead>';
      html += '<tbody>';
      holders.forEach(h => {
        const addr = escapeHtml(h.address);
        const short = h.address.slice(0, 4) + '...' + h.address.slice(-4);
        const bal = h.balance >= 1e9 ? (h.balance / 1e9).toFixed(2) + 'B'
          : h.balance >= 1e6 ? (h.balance / 1e6).toFixed(2) + 'M'
          : h.balance >= 1e3 ? (h.balance / 1e3).toFixed(2) + 'K'
          : h.balance.toFixed(2);
        const pct = h.percentage.toFixed(2) + '%';
        html += `<tr>
          <td>${h.rank}</td>
          <td><a href="https://solscan.io/account/${addr}" target="_blank" rel="noopener" class="holder-address">${short}</a></td>
          <td class="text-right mono">${bal}</td>
          <td class="text-right mono">${pct}</td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    }

    // Diamond hands section — starts as loading skeleton, polls for data
    html += '<div class="cultify-diamond-section" id="cultify-diamond">';
    html += '<h3 style="font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.75rem;">Diamond Hands Distribution</h3>';
    html += '<div id="cultify-diamond-bars">';
    const buckets = ['6h', '24h', '3d', '1w', '1m', '3m', '6m', '9m'];
    const labels = ['>6h', '>24h', '>3d', '>1w', '>1m', '>3m', '>6m', '>9m'];
    buckets.forEach((key, i) => {
      html += `<div class="cultify-dh-row" id="cultify-dh-row-${key}">
        <span class="cultify-dh-label">${labels[i]}</span>
        <div class="cultify-dh-track">
          <div class="cultify-dh-fill cultify-dh-loading" id="cultify-dh-fill-${key}"></div>
        </div>
        <span class="cultify-dh-pct" id="cultify-dh-pct-${key}">...</span>
      </div>`;
    });
    html += '</div>';
    html += '<p id="cultify-diamond-status" style="font-size:0.72rem;color:var(--text-dim);margin-top:0.5rem;">Loading diamond hands data...</p>';
    html += '</div>';

    showResults(html);

    // Start polling for diamond hands data
    pollDiamondHands(mint);
  }

  let diamondPollTimer = null;

  async function pollDiamondHands(mint) {
    if (diamondPollTimer) clearTimeout(diamondPollTimer);

    const baseUrl = (typeof config !== 'undefined' && config.api?.baseUrl) || '';
    const tokenParam = currentAccessToken ? `?token=${currentAccessToken}` : '';

    try {
      const resp = await fetch(`${baseUrl}/api/cultify/diamond-hands/${mint}${tokenParam}`);
      if (!resp.ok) return;
      const data = await resp.json();

      if (data.distribution) {
        const buckets = ['6h', '24h', '3d', '1w', '1m', '3m', '6m', '9m'];
        buckets.forEach(key => {
          const pct = data.distribution[key] || 0;
          const fillEl = document.getElementById(`cultify-dh-fill-${key}`);
          const pctEl = document.getElementById(`cultify-dh-pct-${key}`);
          if (fillEl) {
            fillEl.classList.remove('cultify-dh-loading');
            fillEl.style.width = pct + '%';
            fillEl.className = 'cultify-dh-fill' +
              (pct >= 50 ? ' cultify-dh-high' : pct >= 20 ? ' cultify-dh-mid' : ' cultify-dh-low');
          }
          if (pctEl) pctEl.textContent = pct + '%';
        });

        const statusEl = document.getElementById('cultify-diamond-status');
        if (statusEl) {
          if (data.computed) {
            statusEl.textContent = `${data.analyzed} of ${data.sampleSize} holders analyzed`;
          } else {
            statusEl.textContent = `Analyzing... ${data.analyzed}/${data.sampleSize} holders`;
          }
        }
      }

      // Keep polling if not fully computed
      if (!data.computed) {
        diamondPollTimer = setTimeout(() => pollDiamondHands(mint), 3000);
      }
    } catch {
      // Retry on error
      diamondPollTimer = setTimeout(() => pollDiamondHands(mint), 5000);
    }
  }

  function metricCard(value, label, pct) {
    const cls = pct > 80 ? 'concentration-high' : pct > 50 ? 'concentration-medium' : 'concentration-low';
    return `<div class="cultify-metric">
      <div class="cultify-metric-value ${cls}">${value}</div>
      <div class="cultify-metric-label">${label}</div>
    </div>`;
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

})();
