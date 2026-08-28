/**
 * Where a scanned QR lands.
 *
 * This page has one job and about four seconds to do it: take the two single-use codes out of the
 * URL fragment, spend them, and get the person into whichever apps were paired. It runs before
 * anything else on the phone, so it deliberately loads no wallet adapter and no API client -
 * just config and the pairing client.
 */
(function linkPage() {
  const el = (id) => document.getElementById(id);
  const dom = {
    icon: el('dl-icon'),
    spinner: el('dl-spinner'),
    heading: el('dl-heading'),
    message: el('dl-message'),
    walletChip: el('dl-wallet'),
    results: el('dl-results'),
    actions: el('dl-actions')
  };

  const ICONS = {
    ok: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    tick: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    cross: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  };

  function setIcon(stateName) {
    dom.icon.dataset.state = stateName;
    if (stateName === 'ok') dom.icon.innerHTML = ICONS.ok;
    else if (stateName === 'error') dom.icon.innerHTML = ICONS.error;
  }

  function addResult(name, note, ok) {
    const row = document.createElement('div');
    row.className = 'dl-result';

    const mark = document.createElement('span');
    mark.style.color = ok ? 'var(--green)' : 'var(--red)';
    mark.style.flexShrink = '0';
    mark.innerHTML = ok ? ICONS.tick : ICONS.cross;

    const body = document.createElement('div');
    body.className = 'dl-result-body';
    const title = document.createElement('div');
    title.className = 'dl-result-name';
    title.textContent = name;
    const sub = document.createElement('div');
    sub.className = 'dl-result-note';
    sub.textContent = note;
    body.appendChild(title);
    body.appendChild(sub);

    row.appendChild(mark);
    row.appendChild(body);
    dom.results.appendChild(row);
    dom.results.hidden = false;
  }

  function addAction(label, href, primary) {
    const a = document.createElement('a');
    a.className = `btn ${primary ? 'btn-primary' : 'btn-secondary'}`;
    a.href = href;
    a.textContent = label;
    dom.actions.appendChild(a);
    dom.actions.hidden = false;
  }

  function fail(heading, message) {
    dom.spinner.remove();
    setIcon('error');
    dom.heading.textContent = heading;
    dom.message.textContent = message;
    addAction('Open HolDEX', '/', true);
  }

  async function run() {
    const { siteToken, trenchesToken } = deviceLink.parseLinkHash(window.location.hash);

    /**
     * Strip the codes from the address bar before doing anything with them. From here on the URL
     * is safe to screenshot, share or leave in history: the credentials only exist in this
     * closure. Done first so it happens even if a request below throws.
     */
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname);
    }

    if (!siteToken && !trenchesToken) {
      fail('This link is not valid', 'Generate a fresh code on your desktop and scan it again. Codes expire after two minutes and only work once.');
      return;
    }

    let wallet = null;
    // Whether each half actually PAIRED, which is not the same question as whether the QR
    // carried a code for it. The buttons below are built from these, never from the tokens:
    // sending somebody to Trenches because a Trenches code was present, when redeeming it just
    // failed, lands them on a sign-in screen with no idea why.
    let siteOk = false;
    let trenchesOk = false;

    if (siteToken) {
      try {
        wallet = await deviceLink.redeemSiteCode(siteToken);
        siteOk = true;
        addResult('HolDEX', 'Connected. Your watchlist and holdings are here.', true);
      } catch (err) {
        addResult('HolDEX', err.message || 'Could not connect', false);
      }
    }

    if (trenchesToken) {
      try {
        const trenchesWallet = await deviceLink.redeemTrenchesCode(trenchesToken);
        wallet = wallet || trenchesWallet;
        trenchesOk = true;
        addResult('Trenches', 'Signed in. Alerts, filters and PumpScroll are ready.', true);
      } catch (err) {
        addResult('Trenches', err.message || 'Could not connect', false);
      }
    }

    const anyOk = siteOk || trenchesOk;

    dom.spinner.remove();

    if (!anyOk) {
      setIcon('error');
      dom.heading.textContent = 'That code has been used';
      dom.message.textContent = 'Each code works once and lasts two minutes. Generate a new one on your desktop.';
      addAction('Open HolDEX', '/', true);
      return;
    }

    setIcon('ok');
    // "Partly" matters: one half working and the other not is a different situation from both
    // working, and the heading is the only part of this screen somebody is guaranteed to read.
    const partial = (siteToken && !siteOk) || (trenchesToken && !trenchesOk);
    dom.heading.textContent = partial ? 'Partly connected' : 'Your phone is connected';
    dom.message.textContent = partial
      ? 'One half of the pairing did not go through. Generate a fresh code on your desktop to finish it.'
      : 'Stays connected until you disconnect it from the desktop.';

    if (wallet) {
      dom.walletChip.textContent = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
      dom.walletChip.hidden = false;
    }

    // Trenches first when it paired: it is the thing with a real session, and the reason most
    // people are scanning at all. Built from what succeeded, never from what was offered.
    if (trenchesOk) addAction('Open Trenches', '/trenches/', true);
    if (siteOk) addAction('Open HolDEX', '/', !trenchesOk);
  }

  run().catch(() => {
    fail('Something went wrong', 'We could not reach HolDEX. Check your connection and scan a fresh code.');
  });
})();
