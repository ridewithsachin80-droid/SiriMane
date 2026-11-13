// version-check.js — Sprint 26. "New version available — Refresh", the same
// pattern as AttendEase and FuelBunk Pro.
//
// The server stamps every API response with X-Build (the Railway commit) and
// serves it at /api/version. This script remembers the build the page was
// opened with; when a different build is seen — on any API reply, when the
// app comes back to the foreground, when the phone comes back online, or on
// the 5-minute check — a bar appears at the bottom: one tap reloads. "Later"
// hides it for 30 minutes. Nothing reloads by itself: she may be mid-entry.
(function () {
  const KEY = 'sm_build_seen';
  let current = null, shown = false, snoozedUntil = 0, timer = null;

  function bar() {
    let el = document.getElementById('sm-update-bar');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'sm-update-bar';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="sm-update-text">New version available</span>' +
      '<button type="button" class="sm-update-later" id="sm-update-later">Later</button>' +
      '<button type="button" class="sm-update-go" id="sm-update-go">Refresh</button>';
    document.body.appendChild(el);
    el.querySelector('#sm-update-go').addEventListener('click', refresh);
    el.querySelector('#sm-update-later').addEventListener('click', () => { snoozedUntil = Date.now() + 30 * 60 * 1000; el.remove(); shown = false; });
    return el;
  }

  async function refresh() {
    const go = document.getElementById('sm-update-go'); if (go) { go.disabled = true; go.textContent = 'Refreshing…'; }
    try { if ('serviceWorker' in navigator) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } } catch (e) {}
    try { sessionStorage.setItem(KEY, ''); } catch (e) {}
    location.reload();
  }

  function noticed(build) {
    if (!build) return;
    if (current === null) { current = build; return; }
    if (build === current || shown || Date.now() < snoozedUntil) return;
    shown = true; bar();
  }

  async function check() {
    if (document.visibilityState === 'hidden' || !navigator.onLine) return;
    try {
      const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      noticed(data && data.build);
    } catch (e) { /* offline or flaky: say nothing */ }
  }

  // Every fetch() reply from this server is looked at for X-Build — no extra requests.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.apply(this, arguments).then(res => {
      try { const url = typeof input === 'string' ? input : (input && input.url) || ''; if (/^(\/|https?:\/\/[^/]*\/)api\//.test(url) || /^\/api\//.test(url)) noticed(res.headers.get('X-Build')); } catch (e) {}
      return res;
    });
  };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('online', check);
  window.addEventListener('pageshow', e => { if (e.persisted) check(); });
  timer = setInterval(check, 5 * 60 * 1000);
  check();

  // A new service worker waiting (resident app) is the same news.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return;
      reg.addEventListener('updatefound', () => { const w = reg.installing; if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { shown = true; bar(); } }); });
    }).catch(() => {});
  }

  window.smVersionCheck = { check, _state: () => ({ current, shown, snoozedUntil }), _snooze: ms => { snoozedUntil = Date.now() + ms; }, _reset: () => { shown = false; snoozedUntil = 0; current = null; } };
})();
