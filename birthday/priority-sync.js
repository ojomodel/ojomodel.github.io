(function () {
  'use strict';

  const endpoint = 'https://dashboard.oluwaseuno.com/api/birthday-order';
  const keyName = 'birthday-owner-edit-key';
  const keyPattern = /^[A-Za-z0-9_-]{43}$/;
  const list = document.querySelector('.birthday-list');
  if (!list || !window.BirthdayReorder) return;

  let ownerKey = '';
  let controller;
  let refreshing = false;
  let lastRefresh = 0;
  try { ownerKey = localStorage.getItem(keyName) || ''; } catch (_) { /* The link still works when storage is blocked. */ }
  const fragment = new URLSearchParams(location.hash.slice(1));
  const incomingKey = fragment.get('birthday-edit');
  if (incomingKey !== null) {
    if (keyPattern.test(incomingKey)) {
      ownerKey = incomingKey;
      try { localStorage.setItem(keyName, ownerKey); } catch (_) { /* Keep editing available for this visit. */ }
    }
    // Remove the private fragment before any navigation or share action.
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!keyPattern.test(ownerKey)) ownerKey = '';

  async function request(method, body) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12000);
    const headers = { Accept: 'application/json' };
    if (ownerKey) headers.Authorization = 'Bearer ' + ownerKey;
    if (body) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(endpoint, {
        method, headers, credentials: 'omit', cache: 'no-store',
        signal: abort.signal, body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.message || 'Could not save the shared order.');
        if (response.status === 409) {
          error.code = 'conflict';
          error.latestOrder = data.order;
          error.latestRevision = data.revision;
        }
        throw error;
      }
      if (!Array.isArray(data.order) || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
          data.order.length > 150 || data.order.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
        throw new Error('The saved order could not be read.');
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  const persistence = {
    label: 'Order saved for everyone.',
    async load() {
      const data = await request('GET');
      controller?.setEditable(data.canEdit === true);
      lastRefresh = Date.now();
      return data;
    },
    async save(order, { revision }) {
      const result = await request('PUT', { order, revision });
      lastRefresh = Date.now();
      return result;
    }
  };
  controller = window.BirthdayReorder.mount(list, { editable: false, persistence });
  window.birthdayPriorityController = controller;
  controller.ready.then(() => {
    if (incomingKey && controller.getState().editable) controller.open();
    else if (location.hash) {
      try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' }); }
      catch (_) { /* An invalid bookmark leaves the list usable. */ }
    }
  });

  async function refresh() {
    if (document.hidden || refreshing || controller.getState().opened || Date.now() - lastRefresh < 15000) return;
    refreshing = true;
    try {
      const data = await persistence.load();
      const current = controller.getState();
      if (!current.opened && !current.saving && (current.revision === null || data.revision > current.revision)) {
        controller.setOrder(data.order, data.revision);
      }
    } catch (_) { /* Keep the displayed order available while offline. */ }
    finally { refreshing = false; }
  }
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
})();
