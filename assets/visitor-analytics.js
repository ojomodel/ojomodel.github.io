/* Anonymous portfolio visit counts. No cookies, fingerprints, form data or private pages. */
(() => {
  'use strict';
  const hosts = new Set(['oluwaseuno.com', 'www.oluwaseuno.com']);
  const routes = new Set(['/', '/about/', '/projects/', '/projects/buck-converter/', '/resume/', '/contact/']);
  const path = location.pathname === '/robotic-arm.html' ? '/projects/' : location.pathname;
  if (!hosts.has(location.hostname) || !routes.has(path) || window.__portfolioAnalyticsInstalled ||
      navigator.webdriver || navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  window.__portfolioAnalyticsInstalled = true;
  const endpoint = 'https://dashboard.oluwaseuno.com/api/analytics/collect';
  const key = 'portfolio-visit-v1';
  const idleLimit = 30 * 60 * 1000;
  const uuid = () => crypto.randomUUID();
  const device = /ipad|tablet|android(?!.*mobile)/i.test(navigator.userAgent) ? 'tablet' :
    /mobi|iphone|ipod/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  let source = '';
  try {
    const ref = new URL(document.referrer);
    if (['https:', 'http:'].includes(ref.protocol) && !hosts.has(ref.hostname) &&
        ref.hostname !== 'dashboard.oluwaseuno.com' && ref.hostname.length <= 253 &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(ref.hostname)) source = ref.hostname.toLowerCase();
  } catch { /* Direct visits have no referrer. */ }
  let visit;
  try { visit = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { /* Storage may be disabled. */ }
  function session() {
    const now = Date.now();
    if (!visit || typeof visit.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(visit.id) ||
        typeof visit.last !== 'number' || now - visit.last >= idleLimit || visit.last > now ||
        typeof visit.referrer !== 'string') {
      visit = { id: uuid(), last: now, referrer: source };
    }
    visit.last = now;
    try { sessionStorage.setItem(key, JSON.stringify(visit)); } catch { /* In-memory counting still works. */ }
    return visit;
  }
  function send(type, target) {
    try {
      const current = session();
      const body = { id: uuid(), visitId: current.id, path, type, referrer: current.referrer, device };
      if (target) body.target = target;
      // A simple CORS request survives link navigation, without sending account cookies.
      fetch(endpoint, { method: 'POST', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) }).catch(() => {});
    } catch { /* Analytics must never interrupt the portfolio. */ }
  }
  let viewed = false;
  function view() {
    if (document.visibilityState !== 'visible' || viewed) return;
    viewed = true;
    send('pageview');
  }
  document.addEventListener('visibilitychange', view);
  view();
  let lastClick = { target: '', at: 0 };
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    let link;
    try { link = new URL(anchor.href, location.href); } catch { return; }
    let target;
    if (link.protocol === 'mailto:') target = 'email';
    else if (link.protocol === 'https:' || link.protocol === 'http:') {
      if (link.hostname === 'github.com' || link.hostname === 'www.github.com') target = 'github';
      else if (link.hostname === 'linkedin.com' || link.hostname === 'www.linkedin.com') target = 'linkedin';
      else if (hosts.has(link.hostname)) {
        if (['/resume.pdf', '/assets/oluwaseun-omodele-resume.pdf'].includes(link.pathname) && anchor.hasAttribute('download')) target = 'resume-download';
        else if (['/projects/', '/robotic-arm.html'].includes(link.pathname)) target = 'robotic-arm';
        else if (link.pathname === '/projects/buck-converter/') target = 'buck-converter';
        else if (link.pathname === '/' && !link.hash) target = 'home';
        else if (link.pathname === '/about/') target = 'about';
        else if (link.pathname === '/resume/') target = 'resume';
        else if (link.pathname === '/contact/') target = 'contact';
      }
    }
    if (!target || (lastClick.target === target && Date.now() - lastClick.at < 750)) return;
    lastClick = { target, at: Date.now() };
    send('click', target);
  }, { capture: true, passive: true });
})();
