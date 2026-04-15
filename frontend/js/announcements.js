(function () {
  const STORAGE_KEY = 'cs_dismissed_ann';

  function getDismissed() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }

  function dismiss(id) {
    const list = getDismissed();
    if (!list.includes(id)) {
      list.push(id);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function render(announcements) {
    const banner = document.getElementById('announcement-banner');
    if (!banner) return;
    const dismissed = getDismissed();
    const visible = announcements.filter(a => !dismissed.includes(a.id));
    if (visible.length === 0) { banner.innerHTML = ''; return; }

    banner.innerHTML = visible.map(a => `
      <div class="ann-item ann-${esc(a.type)}" data-ann-id="${a.id}" role="alert">
        <div class="ann-body">
          <span class="ann-title">${esc(a.title)}</span>
          <span class="ann-message">${esc(a.message)}</span>
        </div>
        <button class="ann-dismiss" aria-label="Dismiss announcement" data-dismiss="${a.id}">&times;</button>
      </div>
    `).join('');

    banner.querySelectorAll('[data-dismiss]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.dismiss);
        dismiss(id);
        const item = btn.closest('.ann-item');
        if (item) {
          item.style.opacity = '0';
          item.style.maxHeight = item.offsetHeight + 'px';
          requestAnimationFrame(() => {
            item.style.transition = 'opacity 0.2s, max-height 0.3s, padding 0.3s, margin 0.3s';
            item.style.maxHeight = '0';
            item.style.padding = '0';
            item.style.margin = '0';
            item.style.overflow = 'hidden';
            setTimeout(() => item.remove(), 320);
          });
        }
      });
    });
  }

  async function load() {
    try {
      const base = (typeof config !== 'undefined' && config.api && config.api.baseUrl) ? config.api.baseUrl : '';
      const res = await fetch(base + '/api/announcements', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      render(data.announcements || []);
    } catch { /* non-critical */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
