(function (global, factory) {
  const api = factory(global);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global && global.document) global.BirthdayClaims = api;
})(typeof window === 'undefined' ? null : window, function (global) {
  'use strict';

  const visitorPattern = /^[a-f0-9]{64}$/;
  const itemPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const mounted = new WeakMap();

  function createVisitorId(crypto) {
    if (!crypto || typeof crypto.getRandomValues !== 'function') return null;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function readSnapshot(data, ids, personalRequired) {
    if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        !data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts) ||
        (personalRequired && !Array.isArray(data.claimedIds))) {
      throw new Error('The checkmarks could not be read.');
    }
    const known = new Set(ids);
    const counts = Object.create(null);
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(data.counts, id)) continue;
      const count = data.counts[id];
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('The checkmark count could not be read.');
      counts[id] = count;
    }
    if (Array.isArray(data.claimedIds) && data.claimedIds.some(id => typeof id !== 'string' || !itemPattern.test(id))) {
      throw new Error('The checkmarks could not be read.');
    }
    const claimed = new Set((data.claimedIds || []).filter(id => known.has(id)));
    for (const id of claimed) {
      if (Object.prototype.hasOwnProperty.call(counts, id) && counts[id] < 1) {
        throw new Error('The checkmark count could not be read.');
      }
    }
    return { counts, claimed, revision: data.revision };
  }

  function mount(list, options = {}) {
    if (!list || !list.ownerDocument) throw new TypeError('A birthday list element is required.');
    if (mounted.has(list)) return mounted.get(list);
    const document = list.ownerDocument;
    const window = document.defaultView || global;
    const endpoint = options.endpoint || 'https://dashboard.oluwaseuno.com/api/birthday-claims';
    const storageKey = options.storageKey || 'birthday-visitor-id-v1';
    const signalKey = storageKey + ':changed';
    const requestFetch = options.fetch || (window.fetch && window.fetch.bind(window));
    const pollInterval = Math.max(1000, options.pollIntervalMs ?? 60000);
    const timeoutMs = Math.max(100, options.timeoutMs ?? 12000);
    const hosts = [...list.querySelectorAll('[data-birthday-claim][data-item-id]')];
    const ids = hosts.map(host => host.dataset.itemId);
    if (ids.some(id => !itemPattern.test(id)) || new Set(ids).size !== ids.length) {
      throw new Error('Birthday claim item IDs must be valid and unique.');
    }
    const rows = new Map();
    const pending = new Map();
    const errors = new Map();
    const requests = new Set();
    let visitorId = null;
    let identityEpoch = 0;
    let revision = -1;
    let counts = Object.create(null);
    let claimed = new Set();
    let personalKnown = false;
    let hasSnapshot = false;
    let loading = true;
    let loadError = false;
    let destroyed = false;
    let lastRefresh = 0;
    let refreshPromise = null;
    let refreshEpoch = -1;
    let channel = null;

    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function button(className, text) {
      const node = element('button', className, text);
      node.type = 'button';
      return node;
    }

    const notice = element('div', 'birthday-claims-notice');
    const noticeText = element('p', 'birthday-claims-status');
    noticeText.setAttribute('role', 'status');
    noticeText.setAttribute('aria-live', 'polite');
    const retryAll = button('birthday-claims-retry', 'Retry');
    retryAll.hidden = true;
    notice.append(noticeText, retryAll);
    list.before(notice);

    hosts.forEach((host, index) => {
      const id = ids[index];
      const title = host.closest('.gift-bundle-item, .gift-row')?.querySelector('.gift-bundle-item-title, .gift-title')?.textContent.trim() || id;
      const toggle = button('birthday-claim-toggle');
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', 'I got this — ' + title);
      toggle.disabled = true;
      const icon = element('span', 'birthday-claim-check', '✓');
      icon.setAttribute('aria-hidden', 'true');
      toggle.append(icon, element('span', 'birthday-claim-label', 'I got this'));
      const detail = element('div', 'birthday-claim-detail');
      const count = element('span', 'birthday-claim-count', 'Loading checkmarks…');
      const self = element('span', 'birthday-claim-self', 'You marked this as bought.');
      self.hidden = true;
      detail.append(count, self);
      const message = element('p', 'birthday-claim-message');
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      message.id = 'birthday-claim-status-' + id;
      message.hidden = true;
      toggle.setAttribute('aria-describedby', message.id);
      const retry = button('birthday-claim-retry', 'Retry');
      retry.setAttribute('aria-label', 'Retry checkmark for ' + title);
      retry.hidden = true;
      host.classList.add('birthday-claim');
      host.append(toggle, detail, message, retry);
      rows.set(id, { host, toggle, count, self, message, retry, title });
      toggle.addEventListener('click', () => save(id, !claimed.has(id)));
      retry.addEventListener('click', () => {
        const failure = errors.get(id);
        if (failure) save(id, failure.desired);
      });
    });

    function getStorage() {
      try { return options.storage === undefined ? window.localStorage : options.storage; }
      catch (_) { return null; }
    }

    function persistentIdentity() {
      try {
        const storage = getStorage();
        if (!storage) return null;
        const saved = storage.getItem(storageKey);
        if (typeof saved === 'string' && visitorPattern.test(saved)) return saved;
        const created = createVisitorId(options.crypto || window.crypto);
        if (!created) return null;
        storage.setItem(storageKey, created);
        return storage.getItem(storageKey) === created ? created : null;
      } catch (_) { return null; }
    }

    function checkIdentity() {
      const next = persistentIdentity();
      if (next === visitorId) return;
      visitorId = next;
      identityEpoch += 1;
      personalKnown = false;
      claimed = new Set();
      pending.clear();
      errors.clear();
      for (const request of requests) request.abort();
    }

    function renderNotice() {
      const messages = [];
      if (!visitorId) messages.push('Enable browser storage to remember your checkmarks. You can still view the totals.');
      else messages.push('Check “I got this” if you bought it. Click again to undo. One checkmark per browser, per item.');
      if (loading && !hasSnapshot) messages.push('Loading checkmarks…');
      if (loadError) messages.push(hasSnapshot ? 'Totals may be out of date. Refresh to try again.' : 'Checkmarks could not be loaded. Try again.');
      const text = messages.join(' ');
      if (noticeText.textContent !== text) noticeText.textContent = text;
      retryAll.hidden = !loadError && !!visitorId;
      retryAll.textContent = loading ? 'Loading…' : 'Retry';
      retryAll.disabled = loading;
    }

    function render() {
      if (destroyed) return;
      for (const [id, row] of rows) {
        const knownCount = Object.prototype.hasOwnProperty.call(counts, id);
        const selected = personalKnown && claimed.has(id);
        const saving = pending.has(id);
        const failure = errors.get(id);
        row.toggle.setAttribute('aria-pressed', String(selected));
        row.toggle.setAttribute('aria-busy', String(saving));
        row.toggle.disabled = saving || !visitorId || !personalKnown || !knownCount;
        row.toggle.title = selected ? 'Click again to unmark ' + row.title : 'Mark ' + row.title + ' as bought';
        row.host.dataset.claimState = saving ? 'saving' : failure ? 'error' : selected ? 'claimed' : 'unclaimed';
        row.count.textContent = knownCount ? counts[id] + ' marked as bought' + (loadError ? ' · last loaded' : '') : loading ? 'Loading checkmarks…' : 'Count unavailable';
        row.self.hidden = !selected;
        row.message.hidden = !saving && !failure;
        const message = saving ? 'Saving…' : failure?.message || '';
        if (row.message.textContent !== message) row.message.textContent = message;
        row.retry.hidden = !failure || saving || !visitorId || !personalKnown;
      }
      renderNotice();
    }

    function applySnapshot(data, epoch) {
      if (destroyed || epoch !== identityEpoch) return false;
      const next = readSnapshot(data, ids, !!visitorId);
      if (next.revision < revision) return false;
      revision = next.revision;
      counts = next.counts;
      claimed = next.claimed;
      personalKnown = !!visitorId;
      hasSnapshot = true;
      loadError = false;
      // A fresh authoritative read can resolve an interrupted response to a write.
      for (const [id, failure] of errors) {
        if (personalKnown && claimed.has(id) === failure.desired) errors.delete(id);
      }
      render();
      return true;
    }

    async function request(method, body, identity) {
      if (typeof requestFetch !== 'function') throw new Error('Checkmarks could not be loaded.');
      const Abort = window.AbortController;
      const abort = new Abort();
      requests.add(abort);
      const headers = { Accept: 'application/json' };
      if (identity) headers['X-Birthday-Visitor'] = identity;
      if (body) headers['Content-Type'] = 'application/json';
      const timeout = window.setTimeout(() => abort.abort(), timeoutMs);
      try {
        const response = await requestFetch(endpoint, {
          method, headers, credentials: 'omit', cache: 'no-store', signal: abort.signal,
          body: body ? JSON.stringify(body) : undefined
        });
        let data;
        try { data = await response.json(); }
        catch (_) { throw new Error('The checkmark response could not be read.'); }
        if (!response.ok) {
          const error = new Error(response.status === 429 ? 'Too many requests. Wait a moment, then retry.' : 'The change could not be confirmed. Retry to sync it.');
          error.status = response.status;
          throw error;
        }
        return data;
      } finally {
        window.clearTimeout(timeout);
        requests.delete(abort);
      }
    }

    function notifyOtherTabs() {
      try { channel?.postMessage({ type: 'changed', revision }); } catch (_) { /* Focus/poll refresh remains available. */ }
      try { getStorage()?.setItem(signalKey, revision + ':' + Date.now() + ':' + Math.random()); }
      catch (_) { /* The persistent visitor ID already exists; only the cross-tab signal failed. */ }
    }

    async function save(id, desired) {
      if (destroyed || pending.has(id) || !rows.has(id)) return false;
      const oldIdentity = visitorId;
      checkIdentity();
      if (!visitorId || visitorId !== oldIdentity || !personalKnown) {
        render();
        refresh();
        return false;
      }
      const epoch = identityEpoch;
      const startRevision = revision;
      const marker = {};
      pending.set(id, marker);
      errors.delete(id);
      render();
      try {
        const data = await request('PUT', { itemId: id, claimed: desired }, visitorId);
        if (destroyed || epoch !== identityEpoch) return false;
        applySnapshot(data, epoch);
        lastRefresh = Date.now();
        notifyOtherTabs();
        return true;
      } catch (error) {
        if (destroyed || epoch !== identityEpoch) return false;
        if (personalKnown && revision > startRevision && claimed.has(id) === desired) {
          notifyOtherTabs();
          return true;
        }
        const message = error.status === 429 ? error.message : 'The change could not be confirmed. Retry to sync it.';
        errors.set(id, { desired, message });
        return false;
      } finally {
        if (!destroyed && epoch === identityEpoch && pending.get(id) === marker) {
          pending.delete(id);
          render();
        }
      }
    }

    function refresh() {
      if (destroyed) return Promise.resolve(false);
      checkIdentity();
      if (refreshPromise && refreshEpoch === identityEpoch) return refreshPromise;
      const epoch = identityEpoch;
      refreshEpoch = epoch;
      loading = true;
      render();
      const task = (async () => {
        try {
          const data = await request('GET', undefined, visitorId);
          if (destroyed || epoch !== identityEpoch) return false;
          applySnapshot(data, epoch);
          lastRefresh = Date.now();
          return true;
        } catch (_) {
          if (!destroyed && epoch === identityEpoch) loadError = true;
          return false;
        } finally {
          if (!destroyed && epoch === identityEpoch) { loading = false; render(); }
          if (refreshPromise === task) refreshPromise = null;
        }
      })();
      refreshPromise = task;
      return task;
    }

    function foregroundRefresh() {
      if (!document.hidden && Date.now() - lastRefresh >= 5000) refresh();
    }

    function wentOffline() {
      loadError = true;
      render();
    }

    function storageChanged(event) {
      if (event.key === storageKey || event.key === null) refresh();
      else if (event.key === signalKey && event.newValue) refresh();
    }

    function broadcastChanged(event) {
      if (event.data?.type === 'changed' && Number.isSafeInteger(event.data.revision) && event.data.revision >= revision) refresh();
    }

    retryAll.addEventListener('click', refresh);
    window.addEventListener('focus', foregroundRefresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', wentOffline);
    window.addEventListener('storage', storageChanged);
    document.addEventListener('visibilitychange', foregroundRefresh);
    try {
      if (typeof window.BroadcastChannel === 'function') {
        channel = new window.BroadcastChannel('birthday-claims-v1');
        channel.addEventListener('message', broadcastChanged);
      }
    } catch (_) { channel = null; }
    const poll = window.setInterval(() => { if (!document.hidden) refresh(); }, pollInterval);
    const controller = {
      ready: null,
      refresh,
      getState() {
        return { revision, counts: { ...counts }, claimedIds: [...claimed], pendingIds: [...pending.keys()],
          storageAvailable: !!visitorId, personalKnown, loading, loadError, errorIds: [...errors.keys()] };
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        window.clearInterval(poll);
        window.removeEventListener('focus', foregroundRefresh);
        window.removeEventListener('online', refresh);
        window.removeEventListener('offline', wentOffline);
        window.removeEventListener('storage', storageChanged);
        document.removeEventListener('visibilitychange', foregroundRefresh);
        channel?.close();
        for (const request of requests) request.abort();
        for (const row of rows.values()) {
          row.toggle.remove(); row.count.parentNode.remove(); row.message.remove(); row.retry.remove();
          row.host.classList.remove('birthday-claim');
          delete row.host.dataset.claimState;
        }
        notice.remove();
        mounted.delete(list);
      }
    };
    mounted.set(list, controller);
    controller.ready = refresh();
    return controller;
  }

  return { mount, createVisitorId, readSnapshot };
});
