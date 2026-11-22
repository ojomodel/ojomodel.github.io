(function () {
  'use strict';

  const UNLOCK_URL = 'https://dashboard.oluwaseuno.com/api/birthday/unlock';
  const MANIFEST_URL = '/birthday/protected/manifest.json';
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const PLACEHOLDER_MARK = '#birthday-private-src=';
  const MAX_IMAGE_REQUESTS = 8;

  function privatePath(value, baseURL) {
    try {
      const base = new URL(baseURL);
      const url = new URL(value, base);
      if (url.origin !== base.origin || !url.pathname.startsWith('/birthday/images/')) return null;
      return decodeURIComponent(url.pathname.slice('/birthday/'.length));
    } catch (_) { return null; }
  }

  function readManifest(value, baseURL) {
    if (!value || value.v !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
      throw new Error('The protected list is unavailable. Please try again later.');
    }
    const files = Object.create(null);
    const origin = new URL(baseURL).origin;
    for (const [path, entry] of Object.entries(value.files)) {
      if (!entry || typeof entry.url !== 'string' || typeof entry.mime !== 'string') continue;
      const url = new URL(entry.url, baseURL);
      if (url.origin !== origin || !url.pathname.startsWith('/birthday/protected/') || url.search || url.hash) continue;
      files[path] = { url: url.href, mime: entry.mime };
    }
    if (!files['index.html'] || files['index.html'].mime !== 'text/html') {
      throw new Error('The protected list is unavailable. Please try again later.');
    }
    return files;
  }

  async function importKey(encoded, crypto, decodeBase64) {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/_-]{43}=?$/.test(encoded)) throw new Error('The list could not be opened. Please try again later.');
    const raw = Uint8Array.from(decodeBase64(encoded.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    if (raw.length !== 32) throw new Error('The list could not be opened. Please try again later.');
    try { return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); }
    finally { raw.fill(0); }
  }

  async function decryptBytes(bytes, key, crypto) {
    const input = new Uint8Array(bytes);
    if (input.byteLength < 29) throw new Error('The protected file could not be opened.');
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: input.slice(0, 12), tagLength: 128 }, key, input.slice(12));
  }

  function prepareHTML(html, files, environment) {
    const baseURL = environment.location.href;
    // Move image sources before parsing, so the inert document cannot request plaintext photos.
    const safeHTML = html.replace(/<img\b[^>]*>/gi, tag => tag.replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i, (attribute, doubleQuoted, singleQuoted, bare) => {
      const path = privatePath(doubleQuoted ?? singleQuoted ?? bare, baseURL);
      if (!path) return attribute;
      if (!files[path] || !/^image\/(?:png|jpeg|webp|gif|avif)$/.test(files[path].mime)) throw new Error('A protected photo is missing. Please try again later.');
      return 'src="' + PLACEHOLDER + PLACEHOLDER_MARK + encodeURIComponent(path) + '" data-birthday-private-src="' + path.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
    }));
    const parsed = new environment.DOMParser().parseFromString(safeHTML, 'text/html');
    if (!parsed.querySelector('.birthday-list')) throw new Error('The protected list could not be opened.');
    parsed.querySelectorAll('meta[property^="og:image"],meta[name^="twitter:image"]').forEach(node => node.remove());
    const twitterCard = parsed.querySelector('meta[name="twitter:card"]');
    if (twitterCard) twitterCard.content = 'summary';
    const stylesheet = parsed.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/birthday/lock.css?v=20261122';
    parsed.head.append(stylesheet);
    const tools = parsed.createElement('div');
    tools.className = 'birthday-private-tools';
    tools.innerHTML = '<span data-birthday-photo-status role="status" aria-live="polite" hidden></span><button type="button" data-birthday-photo-retry hidden>Retry photos</button><button type="button" data-birthday-lock>Lock</button>';
    const header = parsed.querySelector('.site-header');
    if (header) header.after(tools);
    else parsed.body.prepend(tools);
    return '<!doctype html>\n' + parsed.documentElement.outerHTML;
  }

  function mountPrivateImages(document, environment, files, key) {
    let decryptionKey = key;
    let stopped = false;
    let active = 0;
    const pending = [];
    const urls = new Map();
    const requests = new Map();
    const seen = new WeakSet();
    const failed = new Set();
    const abort = new environment.AbortController();
    const status = document.querySelector('[data-birthday-photo-status]');
    const retry = document.querySelector('[data-birthday-photo-retry]');

    function updateStatus() {
      if (status) {
        status.hidden = failed.size === 0;
        status.textContent = failed.size ? 'Some photos could not load.' : '';
      }
      if (retry) retry.hidden = failed.size === 0;
    }

    function pump() {
      while (!stopped && active < MAX_IMAGE_REQUESTS && pending.length) {
        const task = pending.shift();
        active += 1;
        (async function () {
          const response = await environment.fetch(files[task.path].url, { credentials: 'omit', cache: 'no-store', signal: abort.signal });
          if (!response.ok) throw new Error('Photo unavailable.');
          const bytes = await decryptBytes(await response.arrayBuffer(), decryptionKey, environment.crypto);
          if (stopped) throw new Error('List locked.');
          const url = environment.URL.createObjectURL(new environment.Blob([bytes], { type: files[task.path].mime }));
          urls.set(task.path, url);
          task.resolve(url);
        })().catch(error => {
          requests.delete(task.path);
          task.reject(error);
        }).finally(() => { active -= 1; pump(); });
      }
    }

    function imageURL(path) {
      if (urls.has(path)) return Promise.resolve(urls.get(path));
      if (requests.has(path)) return requests.get(path);
      const request = new Promise((resolve, reject) => { pending.push({ path, resolve, reject }); });
      requests.set(path, request);
      pump();
      return request;
    }

    function imagePath(image) {
      if (image.dataset.birthdayPrivateSrc) return image.dataset.birthdayPrivateSrc;
      const source = image.getAttribute('src') || '';
      const index = source.indexOf(PLACEHOLDER_MARK);
      if (index < 0) return null;
      try { return decodeURIComponent(source.slice(index + PLACEHOLDER_MARK.length)); }
      catch (_) { return null; }
    }

    async function loadImage(image) {
      const path = imagePath(image);
      if (stopped || !path || !files[path]) return;
      try {
        const url = await imageURL(path);
        if (stopped || !image.isConnected) return;
        image.src = url;
        failed.delete(image);
      } catch (_) {
        if (!stopped && image.isConnected) failed.add(image);
      }
      updateStatus();
    }

    const observer = environment.IntersectionObserver ? new environment.IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadImage(entry.target);
      });
    }, { rootMargin: '600px 0px' }) : null;

    function watch(image) {
      const path = imagePath(image);
      if (stopped || seen.has(image) || !path || !files[path]) return;
      seen.add(image);
      image.dataset.birthdayPrivateSrc = path;
      if (observer) observer.observe(image);
      else if (!image.closest('details:not([open]),[hidden]')) loadImage(image);
    }

    function scan(root) {
      if (root.nodeType !== 1 && root.nodeType !== 9) return;
      if (root.matches?.('img')) watch(root);
      root.querySelectorAll('img').forEach(watch);
    }

    const mutations = new environment.MutationObserver(records => {
      records.forEach(record => {
        if (record.type === 'attributes') watch(record.target);
        else record.addedNodes.forEach(scan);
      });
    });
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    document.addEventListener('toggle', event => {
      if (!event.target.open) return;
      scan(event.target);
      if (!observer) event.target.querySelectorAll('img').forEach(loadImage);
    }, true);
    retry?.addEventListener('click', () => {
      const images = [...failed];
      failed.clear();
      updateStatus();
      images.forEach(loadImage);
    });
    scan(document);

    return {
      destroy() {
        stopped = true;
        decryptionKey = null;
        abort.abort();
        observer?.disconnect();
        mutations.disconnect();
        pending.splice(0).forEach(task => task.reject(new Error('List locked.')));
        urls.forEach(url => environment.URL.revokeObjectURL(url));
        urls.clear();
        requests.clear();
        failed.clear();
      }
    };
  }

  function rateMessage(response) {
    const seconds = Number(response.headers?.get('Retry-After'));
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      return 'Too many attempts. Please try again in ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.');
    }
    return 'Too many attempts. Please wait a few minutes and try again.';
  }

  function boot(environment) {
    const document = environment.document;
    const form = document.getElementById('birthday-unlock-form');
    const input = document.getElementById('birthday-passcode');
    const button = document.getElementById('birthday-unlock-button');
    const status = document.getElementById('birthday-lock-status');
    if (!form || !input || !button || !status) return;
    if (!environment.crypto?.subtle || !environment.TextDecoder) {
      status.textContent = 'This browser cannot open the protected list. Please use a current browser.';
      status.dataset.error = 'true';
      return;
    }
    button.disabled = false;
    let busy = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      input.removeAttribute('aria-invalid');
      status.dataset.error = 'false';
      if (!/^[0-9]{4}$/.test(input.value)) {
        status.textContent = 'Enter the four-digit PIN.';
        status.dataset.error = 'true';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      busy = true;
      button.disabled = true;
      input.disabled = true;
      form.setAttribute('aria-busy', 'true');
      button.textContent = 'Unlocking…';
      status.textContent = 'Opening the birthday list…';
      const abort = new environment.AbortController();
      const timer = environment.setTimeout(() => abort.abort(), 25000);
      let key = null;
      try {
        const body = JSON.stringify({ passcode: input.value });
        input.value = '';
        const response = await environment.fetch(UNLOCK_URL, {
          method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' }, body, signal: abort.signal
        });
        if (response.status === 401 || response.status === 403) {
          input.setAttribute('aria-invalid', 'true');
          throw new Error('That PIN is incorrect. Please try again.');
        }
        if (response.status === 429) throw new Error(rateMessage(response));
        if (!response.ok) throw new Error('The list could not be unlocked right now. Please try again later.');
        const result = await response.json();
        key = await importKey(result.key, environment.crypto, environment.atob.bind(environment));
        delete result.key;
        const manifestResponse = await environment.fetch(MANIFEST_URL, { credentials: 'omit', cache: 'no-store', signal: abort.signal });
        if (!manifestResponse.ok) throw new Error('The protected list is unavailable. Please try again later.');
        const files = readManifest(await manifestResponse.json(), environment.location.href);
        const indexResponse = await environment.fetch(files['index.html'].url, { credentials: 'omit', cache: 'no-store', signal: abort.signal });
        if (!indexResponse.ok) throw new Error('The protected list is unavailable. Please try again later.');
        const plaintext = await decryptBytes(await indexResponse.arrayBuffer(), key, environment.crypto);
        const html = prepareHTML(new environment.TextDecoder('utf-8', { fatal: true }).decode(plaintext), files, environment);
        environment.clearTimeout(timer);
        // Replacing the document keeps the address, owner fragment and existing browser identity.
        document.open();
        document.write(html);
        document.close();
        const images = mountPrivateImages(document, environment, files, key);
        key = null;
        document.querySelector('[data-birthday-lock]')?.addEventListener('click', () => {
          images.destroy();
          document.body.replaceChildren();
          environment.location.reload();
        });
        environment.addEventListener('pagehide', () => {
          images.destroy();
          document.body.replaceChildren();
        }, { once: true });
        environment.addEventListener('pageshow', event => {
          if (event.persisted) environment.location.reload();
        });
      } catch (error) {
        key = null;
        const technicalFailure = ['SyntaxError', 'TypeError', 'OperationError', 'DataError', 'InvalidAccessError', 'NotSupportedError'].includes(error?.name);
        status.textContent = error?.name === 'AbortError' ? 'The request timed out. Please try again.' : (technicalFailure ? 'The list could not be opened. Please try again later.' : (error?.message || 'The list could not be unlocked. Please try again.'));
        status.dataset.error = 'true';
        input.disabled = false;
        button.disabled = false;
        button.textContent = 'Unlock';
        form.removeAttribute('aria-busy');
        input.focus();
      } finally {
        environment.clearTimeout(timer);
        busy = false;
      }
    });
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { readManifest, importKey, decryptBytes, prepareHTML, mountPrivateImages, rateMessage, boot };
  } else boot(window);
})();
