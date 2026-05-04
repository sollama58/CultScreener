// =============================================
// CultScreener PWA — Service Worker Registration & Install Prompt
// =============================================

(function () {
  'use strict';

  let deferredPrompt = null;
  let installBtn = null;

  // ─── Service Worker Registration ────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
        console.log('[PWA] Service worker registered:', reg.scope);

        // Check for updates every 5 min — paused when tab is hidden to avoid wasted checks
        const swUpdateInterval = setInterval(() => {
          if (document.visibilityState === 'visible') reg.update();
        }, 5 * 60 * 1000);

        // Handle updates — show refresh prompt when a new SW finishes installing
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(newWorker);
            }
          });
        });

        // SW_UPDATED message: new SW activated and claimed the page — reload to get fresh HTML.
        // This fires when a newly installed SW calls skipWaiting + clients.claim().
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'SW_UPDATED') {
            // Only reload if the page hasn't been interacted with (no unsaved state)
            // and the SW has fully taken control of this client.
            if (navigator.serviceWorker.controller) {
              window.location.reload();
            }
          }
        });
      } catch (err) {
        console.warn('[PWA] Service worker registration failed:', err);
      }
    });
  }

  // ─── Install Prompt Capture ─────────────────────────────
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallOption();
  });

  // Hide install option if app is installed
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallOption();
    console.log('[PWA] App installed successfully');
  });

  // ─── Install Option in Nav Dropdown ─────────────────────

  function createInstallButton() {
    // Only target the mobile dialog dropdown — never the desktop in-header nav
    const nav = (typeof utils !== 'undefined' && utils._mobileDropdown) || null;
    if (!nav || document.getElementById('pwa-install-nav')) return;

    const btn = document.createElement('button');
    btn.id = 'pwa-install-nav';
    btn.className = 'nav-install-item';
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M12 16l0-12M12 16l-4-4M12 16l4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 20h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
      Install App
    `;

    nav.appendChild(btn);
    installBtn = btn;

    btn.addEventListener('click', handleInstall);
  }

  function showInstallOption() {
    // Don't show if already in standalone mode
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    // Only show on mobile — re-check at display time, not just at event time
    if (!window.matchMedia('(max-width: 768px)').matches) return;

    createInstallButton();
    if (installBtn) installBtn.classList.add('installable');
  }

  function hideInstallOption() {
    if (installBtn) {
      installBtn.classList.remove('installable');
    }
  }

  async function handleInstall() {
    if (!deferredPrompt) return;

    // Close the mobile nav dropdown
    if (typeof utils !== 'undefined' && utils._closeMobileNav) {
      utils._closeMobileNav();
    }

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('[PWA] Install prompt outcome:', outcome);

    deferredPrompt = null;
    hideInstallOption();
  }

  // ─── Update Banner UI ──────────────────────────────────

  function showUpdateBanner(worker) {
    const existing = document.getElementById('pwa-update-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'pwa-update-banner';
    banner.className = 'pwa-update-banner visible';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <div class="pwa-update-content">
        <span>A new version of CultScreener is available.</span>
        <button class="pwa-update-btn" id="pwa-update-accept">Update Now</button>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('pwa-update-accept').addEventListener('click', () => {
      worker.postMessage('skipWaiting');
      window.location.reload();
    });
  }

  // ─── Standalone Detection ──────────────────────────────
  // Add class to body when running as installed app
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    document.documentElement.classList.add('pwa-standalone');
  }

})();
