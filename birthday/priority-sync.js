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

  const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const validId = id => typeof id === 'string' && id.length <= 128 && idPattern.test(id);
  let visibleIds;
  let apiIdsByVisible;
  let visibleIdByApi;
  try {
    const units = [...list.children].filter(node => node.matches('.gift-row[id], .gift-choice[id]'));
    visibleIds = units.map(unit => unit.id);
    if (!visibleIds.length || visibleIds.length > 150 || visibleIds.some(id => !validId(id)) ||
        new Set(visibleIds).size !== visibleIds.length) throw new Error('Invalid visible units.');
    apiIdsByVisible = new Map();
    visibleIdByApi = new Map();
    for (const unit of units) {
      const declaration = unit.getAttribute('data-priority-ids');
      let members = [unit.id];
      if (declaration !== null) {
        if (!unit.classList.contains('gift-bundle') || declaration.length > 32768) throw new Error('Invalid bundle.');
        members = JSON.parse(declaration);
        if (!Array.isArray(members) || !members.length || members.length > 150 ||
            members.some(id => !validId(id) || id === unit.id) || new Set(members).size !== members.length) {
          throw new Error('Invalid bundle members.');
        }
        for (const id of members) {
          const matches = list.querySelectorAll('[id="' + id + '"]');
          if (matches.length !== 1 || !unit.contains(matches[0])) throw new Error('Missing bundle member.');
        }
      } else if (unit.classList.contains('gift-bundle')) {
        throw new Error('Missing bundle declaration.');
      }
      apiIdsByVisible.set(unit.id, members.slice());
      for (const id of members) {
        if (visibleIdByApi.has(id)) throw new Error('Duplicate API unit.');
        visibleIdByApi.set(id, unit.id);
      }
    }
    if (visibleIdByApi.size > 150) throw new Error('Too many API units.');
  } catch (_) {
    const status = document.createElement('p');
    status.className = 'birthday-reorder-status';
    status.setAttribute('role', 'alert');
    status.textContent = 'Birthday priority grouping could not be read. Refresh to try again.';
    list.before(status);
    return;
  }

  function validateOrderDocument(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !Array.isArray(data.order) || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        data.order.length > 150 || data.order.some(id => !validId(id)) || new Set(data.order).size !== data.order.length) {
      throw new Error('The saved order could not be read.');
    }
    return data;
  }

  function collapseOrder(apiOrder) {
    // Iteration keeps a bundle at its earliest saved member rank, even when members were interleaved.
    const collapsed = [...new Set(apiOrder.filter(id => visibleIdByApi.has(id)).map(id => visibleIdByApi.get(id)))];
    return window.BirthdayReorder.mergeOrder(visibleIds, collapsed);
  }

  function expandOrder(visibleOrder) {
    if (!Array.isArray(visibleOrder) || visibleOrder.length > 150 || visibleOrder.some(id => !validId(id)) ||
        new Set(visibleOrder).size !== visibleOrder.length) throw new Error('The birthday order could not be saved.');
    // New visible units are merged exactly as before; every original member ID is emitted once.
    return window.BirthdayReorder.mergeOrder(visibleIds, visibleOrder).flatMap(id => apiIdsByVisible.get(id));
  }

  function visibleDocument(data) {
    validateOrderDocument(data);
    return { ...data, order: collapseOrder(data.order) };
  }

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
        const error = new Error(typeof data?.message === 'string' ? data.message : 'Could not save the shared order.');
        if (response.status === 409) {
          const latest = visibleDocument(data);
          error.code = 'conflict';
          error.latestOrder = latest.order;
          error.latestRevision = latest.revision;
        }
        throw error;
      }
      return visibleDocument(data);
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
      const result = await request('PUT', { order: expandOrder(order), revision });
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
