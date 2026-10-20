(() => {
  'use strict';

  const unlockEndpoint = 'https://dashboard.oluwaseuno.com/api/files/unlock';
  const catalogPath = '/assets/private-files/catalog.enc';
  const form = document.querySelector('#unlock-form');
  const input = document.querySelector('#passcode');
  const submit = form.querySelector('button');
  const message = document.querySelector('#unlock-message');
  const list = document.querySelector('#files-list');
  const lockButton = document.querySelector('#lock-files');
  const title = document.querySelector('#files-title');
  const players = new Set();
  const requests = new Set();
  let session = 0;
  let playbackRequest = 0;
  let decryptionKey = null;
  let unlocking = false;

  function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle('is-error', error);
    input.setAttribute('aria-invalid', String(error));
  }

  function formatTime(seconds) {
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }

  async function request(url, options = {}, format = 'json') {
    const controller = new AbortController();
    requests.add(controller);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
      const body = response.ok ? await (format === 'bytes' ? response.arrayBuffer() : response.json()) : null;
      return { response, body };
    } finally {
      requests.delete(controller);
    }
  }

  async function decrypt(path, key) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/assets/private-files/')) {
      throw new Error('Invalid file location');
    }
    const { response, body } = await request(url, {}, 'bytes');
    if (!response.ok) throw new Error('File unavailable');
    const encrypted = new Uint8Array(body);
    if (encrypted.length < 29) throw new Error('Invalid encrypted file');
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: encrypted.slice(0, 12) },
      key,
      encrypted.slice(12)
    );
  }

  function icon(paused) {
    return paused
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
  }

  function makeButton(label, content, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `audio-control ${className}`;
    button.setAttribute('aria-label', label);
    button.textContent = content;
    return button;
  }

  function addPart(part, index, activeSession) {
    const partName = typeof part.title === 'string' && part.title.trim() ? part.title : `Part ${index + 1}`;
    const article = document.createElement('article');
    article.className = 'file-part';
    const player = document.createElement('div');
    player.className = 'file-player';
    const number = document.createElement('p');
    number.className = 'part-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const heading = document.createElement('h2');
    heading.className = 'part-title';
    heading.id = `part-title-${index + 1}`;
    heading.textContent = partName;
    article.setAttribute('aria-labelledby', heading.id);
    const audio = document.createElement('audio');
    audio.preload = 'none';
    audio.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'audio-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', `${partName} playback`);
    const restart = makeButton(`Restart ${partName}`, '↺', 'restart-control');
    const back10 = makeButton(`Rewind ${partName} 10 seconds`, '−10');
    const back5 = makeButton(`Rewind ${partName} 5 seconds`, '−5');
    const play = makeButton(`Play ${partName}`, '', 'play-control');
    play.innerHTML = icon(true);
    const ahead5 = makeButton(`Forward ${partName} 5 seconds`, '+5');
    const ahead10 = makeButton(`Forward ${partName} 10 seconds`, '+10');
    const seekButtons = [restart, back10, back5, ahead5, ahead10];
    seekButtons.forEach(button => { button.disabled = true; });
    controls.append(restart, back10, back5, play, ahead5, ahead10);
    const timeline = document.createElement('div');
    timeline.className = 'audio-timeline';
    const seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'audio-seek';
    seek.min = '0';
    seek.max = String(Number.isFinite(part.duration) ? part.duration : 0);
    seek.step = '.1';
    seek.value = '0';
    seek.disabled = true;
    seek.setAttribute('aria-label', `Playback position for ${partName}`);
    seek.setAttribute('aria-valuetext', '0:00');
    const time = document.createElement('div');
    time.className = 'audio-time';
    const elapsed = document.createElement('span');
    elapsed.textContent = '0:00';
    const duration = document.createElement('span');
    duration.textContent = formatTime(part.duration);
    time.append(elapsed, duration);
    const status = document.createElement('p');
    status.className = 'audio-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    timeline.append(seek, time);
    player.append(number, heading, audio, controls, timeline, status);
    const transcript = document.createElement('div');
    transcript.className = 'file-transcript';
    const transcriptLabel = document.createElement('p');
    transcriptLabel.className = 'transcript-label';
    transcriptLabel.textContent = typeof part.transcriptSource === 'string' && part.transcriptSource.trim()
      ? part.transcriptSource : 'Transcript';
    const text = document.createElement('p');
    text.className = 'transcript-text';
    const hasTranscript = typeof part.transcript === 'string' && part.transcript.trim().length > 0;
    text.textContent = hasTranscript ? part.transcript : 'Exact Voice Memos transcript not added yet.';
    text.classList.toggle('transcript-empty', !hasTranscript);
    transcript.append(transcriptLabel);
    if (typeof part.transcriptSource === 'string' && /automatic|working draft/i.test(part.transcriptSource)) {
      const notice = document.createElement('p');
      notice.className = 'transcript-notice';
      notice.textContent = 'Wording and speaker attribution may be uncertain. Check against the audio.';
      transcript.append(notice);
    }
    transcript.append(text);
    article.append(player, transcript);
    list.append(article);

    let objectUrl = null;
    let loadPromise = null;
    let cancelLoad = null;
    let ready = false;
    const record = {
      audio,
      dispose() {
        if (cancelLoad) cancelLoad();
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };
    players.add(record);

    function updateButton() {
      play.innerHTML = icon(audio.paused);
      play.setAttribute('aria-label', `${audio.paused ? 'Play' : 'Pause'} ${partName}`);
    }

    function updatePosition() {
      const current = audio.currentTime || 0;
      seek.value = String(current);
      elapsed.textContent = formatTime(current);
      seek.setAttribute('aria-valuetext', `${formatTime(current)} of ${formatTime(audio.duration)}`);
    }

    function setPosition(position) {
      if (!ready) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration || 0, position));
      updatePosition();
    }

    async function ensureAudio() {
      if (ready) return;
      if (loadPromise) return loadPromise;
      loadPromise = (async () => {
        status.classList.remove('is-error');
        status.textContent = 'Loading audio…';
        play.disabled = true;
        const key = decryptionKey;
        if (!key) throw new Error('Locked');
        const data = await decrypt(part.audio, key);
        if (session !== activeSession) throw new DOMException('Locked', 'AbortError');
        objectUrl = URL.createObjectURL(new Blob([data], { type: part.mimeType || 'audio/mp4' }));
        await new Promise((resolve, reject) => {
          function cleanup() {
            audio.removeEventListener('loadedmetadata', loaded);
            audio.removeEventListener('error', failed);
            cancelLoad = null;
          }
          function loaded() { cleanup(); resolve(); }
          function failed() { cleanup(); reject(new Error('Audio cannot be played')); }
          audio.addEventListener('loadedmetadata', loaded, { once: true });
          audio.addEventListener('error', failed, { once: true });
          cancelLoad = () => { cleanup(); reject(new DOMException('Locked', 'AbortError')); };
          audio.src = objectUrl;
          audio.load();
        });
        if (session !== activeSession) throw new DOMException('Locked', 'AbortError');
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('Invalid audio duration');
        ready = true;
        seek.disabled = false;
        seek.max = String(audio.duration);
        duration.textContent = formatTime(audio.duration);
        seekButtons.forEach(button => { button.disabled = false; });
        status.textContent = '';
      })();
      try {
        await loadPromise;
      } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        audio.removeAttribute('src');
        throw error;
      } finally {
        loadPromise = null;
        if (session === activeSession) play.disabled = false;
      }
    }

    play.addEventListener('click', async () => {
      const thisPlayback = ++playbackRequest;
      if (!audio.paused) {
        audio.pause();
        return;
      }
      players.forEach(other => { if (other !== record) other.audio.pause(); });
      try {
        await ensureAudio();
        if (session !== activeSession || thisPlayback !== playbackRequest) return;
        await audio.play();
        status.textContent = '';
        status.classList.remove('is-error');
      } catch (error) {
        if (session !== activeSession || error.name === 'AbortError') return;
        status.textContent = error.name === 'NotAllowedError'
          ? 'Audio is ready. Press play to listen.'
          : 'Audio could not load. Press play to try again.';
        status.classList.add('is-error');
        updateButton();
      }
    });
    restart.addEventListener('click', () => setPosition(0));
    back10.addEventListener('click', () => setPosition(audio.currentTime - 10));
    back5.addEventListener('click', () => setPosition(audio.currentTime - 5));
    ahead5.addEventListener('click', () => setPosition(audio.currentTime + 5));
    ahead10.addEventListener('click', () => setPosition(audio.currentTime + 10));
    seek.addEventListener('input', () => setPosition(Number(seek.value)));
    audio.addEventListener('timeupdate', updatePosition);
    audio.addEventListener('pause', updateButton);
    audio.addEventListener('ended', updateButton);
    audio.addEventListener('play', () => {
      players.forEach(other => { if (other !== record) other.audio.pause(); });
      updateButton();
    });
    audio.addEventListener('error', () => {
      if (!ready || session !== activeSession) return;
      ready = false;
      seek.disabled = true;
      seekButtons.forEach(button => { button.disabled = true; });
      status.textContent = 'Playback failed. Press play to load the audio again.';
      status.classList.add('is-error');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      updateButton();
    });
  }

  function lock({ focus = true } = {}) {
    session += 1;
    playbackRequest += 1;
    decryptionKey = null;
    requests.forEach(controller => controller.abort());
    requests.clear();
    players.forEach(player => player.dispose());
    players.clear();
    list.replaceChildren();
    list.hidden = true;
    lockButton.hidden = true;
    form.hidden = false;
    form.reset();
    unlocking = false;
    submit.disabled = false;
    input.disabled = false;
    form.removeAttribute('aria-busy');
    document.body.classList.remove('is-unlocked');
    showMessage('');
    if (focus) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      input.focus({ preventScroll: true });
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (unlocking) return;
    const passcode = input.value;
    if (!passcode) {
      showMessage('Enter the passcode.', true);
      input.focus();
      return;
    }
    if (!window.crypto?.subtle) {
      showMessage('Open this page over a secure connection to unlock it.', true);
      return;
    }
    unlocking = true;
    const activeSession = ++session;
    submit.disabled = true;
    input.disabled = true;
    form.setAttribute('aria-busy', 'true');
    showMessage('Unlocking…');
    try {
      const { response, body: result } = await request(unlockEndpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode })
      });
      if (session !== activeSession) return;
      if (!response.ok) {
        if (response.status === 401) throw new Error('Incorrect passcode. Try again.');
        if (response.status === 429) throw new Error('Too many attempts. Try again later.');
        throw new Error('Unable to unlock right now. Please try again.');
      }
      if (typeof result.key !== 'string') throw new Error('Unable to unlock right now. Please try again.');
      const keyBytes = Uint8Array.from(atob(result.key.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      if (keyBytes.length !== 32) throw new Error('Unable to unlock right now. Please try again.');
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      keyBytes.fill(0);
      const plaintext = await decrypt(catalogPath, key);
      if (session !== activeSession) return;
      const catalog = JSON.parse(new TextDecoder().decode(plaintext));
      if (!Array.isArray(catalog.parts) || !catalog.parts.length || catalog.parts.some(part => !part || typeof part.audio !== 'string')) {
        throw new Error('The files are unavailable right now. Please try again.');
      }
      decryptionKey = key;
      list.replaceChildren();
      catalog.parts.forEach((part, index) => addPart(part, index, activeSession));
      input.value = '';
      form.hidden = true;
      lockButton.hidden = false;
      list.hidden = false;
      document.body.classList.add('is-unlocked');
      showMessage('');
      title.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (error) {
      if (session !== activeSession || error.name === 'AbortError') return;
      decryptionKey = null;
      input.value = '';
      const knownError = /^(Incorrect passcode|Too many attempts|Unable to unlock|The files are unavailable)/.test(error.message);
      showMessage(knownError ? error.message : 'Unable to load the files. Please try again.', true);
    } finally {
      if (session === activeSession) {
        unlocking = false;
        submit.disabled = false;
        input.disabled = false;
        form.removeAttribute('aria-busy');
        if (!form.hidden) input.focus();
      }
    }
  });

  lockButton.addEventListener('click', () => lock());
  window.addEventListener('pagehide', () => lock({ focus: false }));
})();
