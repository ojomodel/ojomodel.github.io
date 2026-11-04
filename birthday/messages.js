(function (global, factory) {
  const api = factory(global);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global && global.document) global.BirthdayMessages = api;
})(typeof window === 'undefined' ? null : window, function (global) {
  'use strict';

  const visitorPattern = /^[a-f0-9]{64}$/;
  const ownerPattern = /^[A-Za-z0-9_-]{43}$/;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const mounted = new WeakMap();
  let instanceNumber = 0;

  function characterCount(value) { return Array.from(value).length; }
  function validTime(value) { return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000; }

  function randomHex(crypto, length) {
    if (!crypto || typeof crypto.getRandomValues !== 'function') return null;
    try {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    } catch (_) { return null; }
  }

  function createId(crypto) {
    if (crypto && typeof crypto.randomUUID === 'function') {
      try {
        const result = crypto.randomUUID();
        if (uuidV4Pattern.test(result)) return result.toLowerCase();
      } catch (_) { /* Try getRandomValues before declaring the browser unsupported. */ }
    }
    const raw = randomHex(crypto, 16);
    if (!raw) return null;
    const bytes = raw.match(/../g).map(part => parseInt(part, 16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function readReceipt(data, expectedId) {
    if (!data || data.id !== expectedId || data.received !== true || !validTime(data.createdAt)) {
      throw new Error('The message receipt could not be confirmed.');
    }
    return { id: data.id, received: true, createdAt: data.createdAt };
  }

  function readInbox(data) {
    if (!data || !Array.isArray(data.messages) || data.messages.length > 50 ||
        !(data.nextCursor === null || (typeof data.nextCursor === 'string' && data.nextCursor.length > 0 && data.nextCursor.length <= 512))) {
      throw new Error('Messages could not be read.');
    }
    const seen = new Set();
    const messages = data.messages.map(message => {
      if (!message || !uuidPattern.test(message.id) || typeof message.message !== 'string' ||
          !message.message.trim() || characterCount(message.message) > 2000 || !validTime(message.createdAt) || seen.has(message.id)) {
        throw new Error('Messages could not be read.');
      }
      seen.add(message.id);
      return { id: message.id, message: message.message, createdAt: message.createdAt };
    });
    return { messages, nextCursor: data.nextCursor };
  }

  function mount(container, options = {}) {
    if (!container || !container.ownerDocument) throw new TypeError('A birthday messages container is required.');
    if (mounted.has(container)) return mounted.get(container);
    const document = container.ownerDocument;
    const window = document.defaultView || global;
    const endpoint = options.endpoint || 'https://dashboard.oluwaseuno.com/api/birthday-messages';
    const fetchRequest = options.fetch || (window.fetch && window.fetch.bind(window));
    const crypto = options.crypto || window.crypto;
    const visitorKey = 'birthday-visitor-id-v1';
    const ownerKeyName = 'birthday-owner-edit-key';
    let incomingOwnerKey = '';
    try {
      const incoming = new window.URLSearchParams(window.location.hash.slice(1)).get('birthday-edit');
      if (typeof incoming === 'string' && ownerPattern.test(incoming)) incomingOwnerKey = incoming;
    } catch (_) { /* Ignore malformed public fragments. Existing priority-sync owns fragment cleanup. */ }
    const draftKey = options.draftKey || 'birthday-message-draft-v1';
    const timeoutMs = Math.max(100, options.timeoutMs ?? 12000);
    const pollMs = Math.max(1000, options.pollIntervalMs ?? 60000);
    const prefix = 'birthday-message-' + (++instanceNumber);
    const requests = new Set();
    let destroyed = false;
    let sending = false;
    let draftText = '';
    let attempt = null;
    let memoryVisitor = null;
    let ownerKey = '';
    let ownerEpoch = 0;
    let ownerLoading = false;
    let ownerLoaded = false;
    let ownerMessages = [];
    let nextCursor = null;
    let ownerError = '';
    let ownerPromise = null;
    let ownerAbort = null;
    let lastInboxRefresh = 0;

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
    function storage(kind) {
      try {
        if (kind === 'draft') return options.draftStorage === undefined ? window.sessionStorage : options.draftStorage;
        return options.storage === undefined ? window.localStorage : options.storage;
      } catch (_) { return null; }
    }
    function getOwnerKey() {
      if (incomingOwnerKey) return incomingOwnerKey;
      try {
        const key = storage('local')?.getItem(ownerKeyName);
        return typeof key === 'string' && ownerPattern.test(key) ? key : '';
      } catch (_) { return ''; }
    }
    function getVisitor() {
      try {
        const saved = storage('local')?.getItem(visitorKey);
        if (typeof saved === 'string' && visitorPattern.test(saved)) return saved;
      } catch (_) { /* A cryptographic memory-only visitor still permits a private message. */ }
      if (!memoryVisitor) memoryVisitor = randomHex(crypto, 32);
      if (memoryVisitor) {
        try { storage('local')?.setItem(visitorKey, memoryVisitor); } catch (_) { /* No login or storage permission is needed to send. */ }
      }
      return memoryVisitor;
    }
    function saveDraft() {
      try {
        const target = storage('draft');
        if (!target) return;
        if (!draftText && !attempt) target.removeItem(draftKey);
        else target.setItem(draftKey, JSON.stringify({ version: 1, text: draftText, attempt }));
      } catch (_) { /* Draft persistence is optional and does not block sending. */ }
    }
    try {
      const raw = storage('draft')?.getItem(draftKey);
      if (raw && raw.length <= 18000) {
        const saved = JSON.parse(raw);
        if (saved?.version === 1 && typeof saved.text === 'string' && saved.text.length <= 8000) {
          draftText = saved.text;
          const old = saved.attempt;
          if (old && uuidPattern.test(old.id) && visitorPattern.test(old.identity) &&
              typeof old.message === 'string' && old.message === draftText.trim() && characterCount(old.message) <= 2000) {
            attempt = { id: old.id, identity: old.identity, message: old.message };
          }
        }
      }
    } catch (_) { /* Ignore blocked, invalid or outdated optional draft storage. */ }

    container.classList.add('birthday-messages');
    const heading = element('h2', 'birthday-messages-heading');
    const label = element('label', '', 'Did you get something?');
    label.htmlFor = prefix + '-text';
    heading.append(label);
    const privacy = element('p', 'birthday-messages-privacy', 'Only Oluwaseun can read your message.');
    privacy.id = prefix + '-privacy';
    const form = element('form', 'birthday-message-form');
    form.noValidate = true;
    const textarea = element('textarea', 'birthday-message-input');
    textarea.id = prefix + '-text';
    textarea.name = 'message';
    textarea.rows = 4;
    textarea.maxLength = 4000; // Two UTF-16 code units may represent one Unicode character.
    textarea.placeholder = 'Leave a private note.';
    textarea.value = draftText;
    textarea.setAttribute('aria-describedby', privacy.id + ' ' + prefix + '-status');
    const controls = element('div', 'birthday-message-controls');
    const submit = button('birthday-message-send', 'Send message');
    submit.type = 'submit';
    const counter = element('span', 'birthday-message-counter');
    counter.setAttribute('aria-label', 'Message length');
    controls.append(submit, counter);
    const status = element('p', 'birthday-message-status');
    status.id = prefix + '-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    form.append(textarea, controls, status);

    const inbox = element('details', 'birthday-message-inbox');
    inbox.hidden = true;
    const summary = element('summary', 'birthday-message-inbox-summary', 'Messages');
    const loadedCount = element('span', 'birthday-message-loaded-count');
    summary.append(loadedCount);
    const inboxControls = element('div', 'birthday-message-inbox-controls');
    const refreshButton = button('birthday-message-refresh', 'Refresh');
    const moreButton = button('birthday-message-more', 'Load more');
    moreButton.hidden = true;
    inboxControls.append(refreshButton, moreButton);
    const inboxStatus = element('p', 'birthday-message-inbox-status');
    inboxStatus.setAttribute('role', 'status');
    inboxStatus.setAttribute('aria-live', 'polite');
    const inboxList = element('ol', 'birthday-message-notes');
    const empty = element('p', 'birthday-message-empty', 'No messages yet.');
    inbox.append(summary, inboxControls, inboxStatus, empty, inboxList);
    container.append(heading, privacy, form, inbox);

    function setStatus(text, state = '') {
      if (destroyed) return;
      if (status.textContent !== text) status.textContent = text;
      form.dataset.status = state;
    }
    function updateForm() {
      if (destroyed) return;
      const count = characterCount(textarea.value);
      counter.textContent = count.toLocaleString() + ' / 2,000';
      counter.dataset.overLimit = String(count > 2000);
      submit.disabled = sending || count > 2000;
      submit.textContent = sending ? 'Sending…' : 'Send message';
      textarea.readOnly = sending;
      textarea.setAttribute('aria-invalid', String(count > 2000));
      form.setAttribute('aria-busy', String(sending));
    }
    function inputChanged() {
      if (textarea.value !== draftText) {
        draftText = textarea.value;
        // Whitespace-only edits do not change the payload actually sent to the server.
        if (attempt && draftText.trim() !== attempt.message) attempt = null;
        saveDraft();
      }
      updateForm();
      if (!sending) setStatus(characterCount(textarea.value) > 2000 ? 'Keep your message to 2,000 characters or fewer.' : '', characterCount(textarea.value) > 2000 ? 'error' : '');
    }

    async function request(url, method, headers, body, captureAbort) {
      if (typeof fetchRequest !== 'function') throw new Error('Messages are unavailable in this browser.');
      const abort = new window.AbortController();
      requests.add(abort);
      if (captureAbort) captureAbort(abort);
      const timeout = window.setTimeout(() => abort.abort(), timeoutMs);
      try {
        const response = await fetchRequest(url, {
          method, credentials: 'omit', cache: 'no-store', headers,
          body: body ? JSON.stringify(body) : undefined, signal: abort.signal
        });
        if (!response.ok) {
          const error = new Error('The request could not be confirmed.');
          error.status = response.status;
          throw error;
        }
        let data;
        try { data = await response.json(); } catch (_) { throw new Error('The response could not be read.'); }
        return data;
      } finally {
        window.clearTimeout(timeout);
        requests.delete(abort);
      }
    }

    async function send(event) {
      event?.preventDefault();
      if (sending || destroyed) return false;
      const raw = textarea.value;
      const text = raw.trim();
      if (!text) { setStatus('Write a message before sending.', 'error'); textarea.focus(); return false; }
      if (characterCount(raw) > 2000) { setStatus('Keep your message to 2,000 characters or fewer.', 'error'); textarea.focus(); return false; }
      if (!attempt || attempt.message !== text) {
        const id = createId(crypto);
        const identity = getVisitor();
        if (!id || !identity) { setStatus('Sending is not supported in this browser. Try refreshing or using a newer browser.', 'error'); return false; }
        attempt = { id, identity, message: text };
      }
      draftText = raw;
      saveDraft();
      const submitted = attempt;
      sending = true;
      setStatus('Sending…', 'sending');
      updateForm();
      try {
        const data = await request(endpoint, 'POST', { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Birthday-Visitor': submitted.identity }, { id: submitted.id, message: submitted.message });
        if (destroyed) return false;
        readReceipt(data, submitted.id);
        if (attempt === submitted && textarea.value.trim() === submitted.message) {
          textarea.value = ''; draftText = ''; attempt = null; saveDraft();
          setStatus('Message sent. Thank you!', 'success');
        } else setStatus('Message sent. Your edited draft is still here.', 'success');
        refreshInbox();
        return true;
      } catch (error) {
        if (destroyed) return false;
        const message = error.status === 429 ? 'Too many messages right now. Please wait, then try again.'
          : error.status === 409 ? 'This draft could not be matched to its receipt. Edit the text before sending again.'
          : error.status === 400 || error.status === 413 ? 'Check your message length and try again. Your text is still here.'
          : 'Couldn’t confirm delivery. Your text is still here. Try again to resend the same message safely.';
        setStatus(message, 'error');
        return false;
      } finally {
        if (!destroyed) { sending = false; updateForm(); }
      }
    }

    function checkOwner() {
      const next = getOwnerKey();
      if (next === ownerKey) return;
      ownerKey = next; ownerEpoch += 1;
      ownerAbort?.abort();
      ownerLoaded = false; ownerLoading = false; ownerMessages = []; nextCursor = null; ownerError = '';
      inbox.hidden = true; inbox.open = false; inboxList.replaceChildren();
    }
    function renderInbox() {
      if (destroyed) return;
      inbox.hidden = !ownerLoaded;
      if (!ownerLoaded) return;
      inbox.setAttribute('aria-busy', String(ownerLoading));
      loadedCount.textContent = ' · ' + ownerMessages.length + ' loaded';
      refreshButton.disabled = ownerLoading;
      refreshButton.textContent = ownerLoading ? 'Loading…' : 'Refresh';
      moreButton.disabled = ownerLoading;
      moreButton.hidden = nextCursor === null;
      if (inboxStatus.textContent !== ownerError) inboxStatus.textContent = ownerError;
      empty.hidden = ownerMessages.length > 0;
      const fragment = document.createDocumentFragment();
      for (const message of ownerMessages) {
        const row = element('li', 'birthday-message-note');
        const time = element('time', 'birthday-message-date');
        const date = new Date(message.createdAt);
        time.dateTime = date.toISOString();
        time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
        const text = element('p', 'birthday-message-note-text', message.message);
        row.append(time, text); fragment.append(row);
      }
      inboxList.replaceChildren(fragment);
    }

    function refreshInbox(settings = {}) {
      if (destroyed) return Promise.resolve(false);
      checkOwner();
      if (!ownerKey) return Promise.resolve(false);
      if (ownerLoading && ownerPromise) return ownerPromise;
      const append = settings.append === true && ownerLoaded;
      const cursor = append ? nextCursor : null;
      if (append && cursor === null) return Promise.resolve(false);
      const key = ownerKey;
      const epoch = ownerEpoch;
      const url = new window.URL(endpoint, window.location.href);
      url.searchParams.set('limit', '50');
      if (cursor) url.searchParams.set('cursor', cursor);
      ownerLoading = true; ownerError = ''; renderInbox();
      const task = (async () => {
        try {
          const data = await request(url.toString(), 'GET', { Accept: 'application/json', Authorization: 'Bearer ' + key }, undefined, abort => { ownerAbort = abort; });
          if (destroyed || epoch !== ownerEpoch) return false;
          // The key may have been removed while the response was in flight.
          if (getOwnerKey() !== key) { checkOwner(); return false; }
          const page = readInbox(data);
          if (cursor !== null && page.nextCursor === cursor) throw new Error('The next message page could not be read.');
          const merged = new Map((append ? ownerMessages : []).map(message => [message.id, message]));
          for (const message of page.messages) merged.set(message.id, message);
          ownerMessages = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
          nextCursor = page.nextCursor;
          ownerLoaded = true;
          lastInboxRefresh = Date.now();
          return true;
        } catch (error) {
          if (destroyed || epoch !== ownerEpoch) return false;
          if (error.status === 401 || error.status === 403) {
            ownerLoaded = false; ownerMessages = []; nextCursor = null; inboxList.replaceChildren();
          } else ownerError = 'Messages could not be refreshed. Try again.';
          return false;
        } finally {
          if (!destroyed && epoch === ownerEpoch) { ownerLoading = false; ownerAbort = null; renderInbox(); }
          if (ownerPromise === task) ownerPromise = null;
        }
      })();
      ownerPromise = task;
      return task;
    }

    function foregroundRefresh() {
      checkOwner();
      if (!document.hidden && !inbox.open && Date.now() - lastInboxRefresh >= 15000) refreshInbox();
    }
    function ownerStorageChanged(event) {
      if (event.key === ownerKeyName || event.key === null) refreshInbox();
    }
    textarea.addEventListener('input', inputChanged);
    form.addEventListener('submit', send);
    refreshButton.addEventListener('click', () => refreshInbox());
    moreButton.addEventListener('click', () => refreshInbox({ append: true }));
    window.addEventListener('storage', ownerStorageChanged);
    window.addEventListener('focus', foregroundRefresh);
    window.addEventListener('online', foregroundRefresh);
    document.addEventListener('visibilitychange', foregroundRefresh);
    const poll = window.setInterval(foregroundRefresh, pollMs);
    const controller = {
      ready: null,
      refreshInbox,
      getState() {
        return { sending, draftLength: characterCount(textarea.value), hasPendingReceipt: !!attempt,
          ownerVisible: ownerLoaded, ownerLoading, messageCount: ownerMessages.length, hasMore: nextCursor !== null };
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        window.clearInterval(poll);
        window.removeEventListener('storage', ownerStorageChanged);
        window.removeEventListener('focus', foregroundRefresh);
        window.removeEventListener('online', foregroundRefresh);
        document.removeEventListener('visibilitychange', foregroundRefresh);
        for (const abort of requests) abort.abort();
        heading.remove(); privacy.remove(); form.remove(); inbox.remove();
        container.classList.remove('birthday-messages');
        mounted.delete(container);
      }
    };
    mounted.set(container, controller);
    updateForm();
    if (characterCount(textarea.value) > 2000) setStatus('Keep your message to 2,000 characters or fewer.', 'error');
    controller.ready = refreshInbox();
    return controller;
  }

  return { mount, characterCount, createId, readReceipt, readInbox };
});
