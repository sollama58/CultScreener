// =============================================
// CultScreener PWA — Service Worker Registration & Install Prompt
// =============================================

(function () {
  'use strict';

  let deferredPrompt = null;
  let installBanner = null;

  // ─── Service Worker Registration ────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
        console.log('[PWA] Service worker registered:', reg.scope);

        // Check for updates periodically (every 60 min)
        setInterval(() => reg.update(), 60 * 60 * 1000);

        // Handle updates — show refresh prompt
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(newWorker);
            }
          });
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
    showInstallBanner();
  });

  // Hide banner if app is installed
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner();
    console.log('[PWA] App installed successfully');
  });

  // ─── Mobile Detection ───────────────────────────────────
  function isMobileDevice() {
    return window.matchMedia('(max-width: 768px)').matches
      || /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  // ─── Install Bubble UI (mobile-only, bottom-right) ─────

  function createInstallBubble() {
    if (document.getElementById('pwa-install-bubble')) return;

    const bubble = document.createElement('button');
    bubble.id = 'pwa-install-bubble';
    bubble.className = 'pwa-install-bubble';
    bubble.setAttribute('aria-label', 'Install CultScreener app');
    bubble.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 16l0-12M12 16l-4-4M12 16l4-4" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 20h16" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
    `;

    document.body.appendChild(bubble);
    installBanner = bubble;

    bubble.addEventListener('click', handleInstall);
  }

  function showInstallBanner() {
    // Only show on mobile devices
    if (!isMobileDevice()) return;

    // Don't show if user previously dismissed (respect for 7 days)
    const dismissed = localStorage.getItem('pwa-install-dismissed');
    if (dismissed && Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000) return;

    // Don't show if already in standalone mode
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    createInstallBubble();
    // Animate in after a short delay (don't interrupt initial page load)
    setTimeout(() => {
      if (installBanner) installBanner.classList.add('visible');
    }, 2000);
  }

  function hideInstallBanner() {
    if (installBanner) {
      installBanner.classList.remove('visible');
      setTimeout(() => {
        installBanner.remove();
        installBanner = null;
      }, 300);
    }
  }

  async function handleInstall() {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('[PWA] Install prompt outcome:', outcome);

    if (outcome === 'dismissed') {
      localStorage.setItem('pwa-install-dismissed', Date.now().toString());
    }

    deferredPrompt = null;
    hideInstallBanner();
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
