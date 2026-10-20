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

  function transcriptCues(part) {
    if (!Array.isArray(part.cues)) return [];
    return part.cues.filter(cue => cue
      && Number.isFinite(cue.start) && cue.start >= 0
      && Number.isFinite(cue.end) && cue.end > cue.start
      && typeof cue.text === 'string' && cue.text.trim())
      .slice().sort((first, second) => first.start - second.start);
  }

  function activeCueIndex(cues, seconds) {
    if (!Number.isFinite(seconds)) return -1;
    for (let index = cues.length - 1; index >= 0; index -= 1) {
      if (cues[index].start <= seconds && seconds < cues[index].end) return index;
    }
    return -1;
  }

  function validTextRange(range, text) {
    if (!range || !Number.isInteger(range.charStart) || !Number.isInteger(range.charEnd)
      || range.charStart < 0 || range.charEnd <= range.charStart || range.charEnd > text.length) return false;
    // Offsets are UTF-16 indices, like String.slice. Never split a surrogate pair.
    const splitsPair = index => index > 0 && index < text.length
      && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
    return !splitsPair(range.charStart) && !splitsPair(range.charEnd);
  }

  function transcriptVersions(part) {
    if (!Array.isArray(part.transcriptVersions)) return [];
    const usedIds = new Set();
    return part.transcriptVersions.filter(version => {
      if (!version || !['original', 'clarified'].includes(version.id)
        || usedIds.has(version.id) || typeof version.text !== 'string' || !version.text.trim()) return false;
      usedIds.add(version.id);
      return true;
    }).map(version => {
      const passages = Array.isArray(version.passages)
        ? version.passages.filter(passage => validTextRange(passage, version.text)) : [];
      let lastEnd = 0;
      const words = (Array.isArray(version.words) ? version.words : [])
        .filter(word => validTextRange(word, version.text)
          && Number.isFinite(word.start) && word.start >= 0
          && Number.isFinite(word.end) && word.end > word.start)
        .slice().sort((first, second) => first.charStart - second.charStart)
        .filter(word => {
          if (word.charStart < lastEnd) return false;
          lastEnd = word.charEnd;
          return true;
        }).map(word => ({
          ...word,
          emphasized: passages.some(passage => word.charStart < passage.charEnd && word.charEnd > passage.charStart)
        }));
      return {
        id: version.id,
        label: typeof version.label === 'string' && version.label.trim()
          ? version.label : version.id === 'original' ? 'Original' : 'Clarified',
        description: typeof version.description === 'string' ? version.description : '',
        text: version.text,
        words
      };
    });
  }

  function wordProgress(word, seconds) {
    if (!Number.isFinite(seconds) || seconds < word.start) return 0;
    if (seconds >= word.end) return 1;
    return Math.max(0, Math.min(1, (seconds - word.start) / (word.end - word.start)));
  }

  function groupTranscriptPhrases(version, referenceVersion = version) {
    if (!version.words.length) return [];
    const reference = referenceVersion.words.length === version.words.length ? referenceVersion : version;
    const phrases = [];
    let first = 0;
    let charStart = 0;
    reference.words.forEach((word, index) => {
      const count = index - first + 1;
      const next = reference.words[index + 1];
      const gap = next ? next.start - word.end : 0;
      const text = reference.text.slice(word.charStart, word.charEnd);
      const terminal = /[.?!…]["'”’)]*$/.test(text);
      const softBreak = /[,;:]["'”’)]*$/.test(text);
      if (!next || count >= 14 || (terminal && (count >= 4 || gap >= .7))
        || (gap >= .7 && count >= 3) || (softBreak && count >= 8)) {
        const charEnd = version.words[index + 1]?.charStart ?? version.text.length;
        phrases.push({
          charStart,
          charEnd,
          wordIndices: Array.from({ length: count }, (_, offset) => first + offset),
          start: version.words[first].start,
          end: version.words[index].end
        });
        first = index + 1;
        charStart = charEnd;
      }
    });
    return phrases;
  }

  function appendTimedText(container, version, referenceVersion = version) {
    const wordElements = [];
    const phrases = groupTranscriptPhrases(version, referenceVersion);
    if (!phrases.length) container.append(document.createTextNode(version.text));
    phrases.forEach(phrase => {
      const line = document.createElement('span');
      line.className = 'lyrics-line';
      let offset = phrase.charStart;
      phrase.wordIndices.forEach(wordIndex => {
        const word = version.words[wordIndex];
        line.append(document.createTextNode(version.text.slice(offset, word.charStart)));
        const span = document.createElement('span');
        span.className = 'transcript-word';
        if (word.emphasized) span.classList.add('is-key-word');
        span.textContent = version.text.slice(word.charStart, word.charEnd);
        line.append(span);
        wordElements.push({ word, span, line, progress: -1, current: false, emphasized: false });
        offset = word.charEnd;
      });
      line.append(document.createTextNode(version.text.slice(offset, phrase.charEnd)));
      container.append(line);
    });
    return wordElements;
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
    const versions = transcriptVersions(part);
    const cues = versions.length ? [] : transcriptCues(part);
    const cueElements = [];
    const wordElements = [];
    const lyricViews = [];
    const lyricCleanup = [];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const transcriptMetadata = [transcriptLabel];
    if (typeof part.transcriptSource === 'string' && /automatic|working draft/i.test(part.transcriptSource)) {
      const notice = document.createElement('p');
      notice.className = 'transcript-notice';
      notice.textContent = 'Wording and speaker attribution may be uncertain. Check against the audio.';
      transcriptMetadata.push(notice);
    }
    const notes = Array.isArray(part.transcriptNotes)
      ? part.transcriptNotes.filter(note => typeof note === 'string' && note.trim()) : [];
    if (notes.length) {
      const details = document.createElement('details');
      details.className = 'transcript-notes';
      const summary = document.createElement('summary');
      summary.textContent = 'Transcript notes';
      const noteList = document.createElement('ul');
      notes.forEach(note => {
        const item = document.createElement('li');
        item.textContent = note;
        noteList.append(item);
      });
      details.append(summary, noteList);
      transcriptMetadata.push(details);
    }
    if (versions.length) {
      article.classList.add('has-transcript-versions');
      const comparison = document.createElement('div');
      comparison.className = 'transcript-comparison';
      const tabs = document.createElement('div');
      tabs.className = 'transcript-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', `${partName} transcript version`);
      const panels = [];
      const tabButtons = [];
      let selectedVersion = 0;
      const referenceVersion = versions.find(version => version.id === 'original') || versions[0];
      versions.forEach((version, versionIndex) => {
        const id = `part-${index + 1}-${version.id}`;
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.id = `${id}-tab`;
        tab.className = 'transcript-tab';
        tab.textContent = version.label;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `${id}-panel`);
        tab.addEventListener('click', () => {
          selectedVersion = versionIndex;
          updateComparison();
          updateTranscript();
          centerLyrics(lyricViews[versionIndex], true);
        });
        tab.addEventListener('keydown', event => {
          let next = selectedVersion;
          if (event.key === 'ArrowRight') next = (next + 1) % versions.length;
          else if (event.key === 'ArrowLeft') next = (next + versions.length - 1) % versions.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = versions.length - 1;
          else return;
          event.preventDefault();
          selectedVersion = next;
          updateComparison();
          tabButtons[next].focus();
          updateTranscript();
          centerLyrics(lyricViews[next], true);
        });
        tabs.append(tab);
        tabButtons.push(tab);
        const panel = document.createElement('section');
        panel.className = 'transcript-version';
        panel.id = `${id}-panel`;
        const versionHeading = document.createElement('h3');
        versionHeading.className = 'transcript-version-title';
        versionHeading.id = `${id}-heading`;
        versionHeading.textContent = version.label;
        panel.append(versionHeading);
        if (version.description) {
          const description = document.createElement('p');
          description.className = 'transcript-version-description';
          description.textContent = version.description;
          panel.append(description);
        }
        const versionText = document.createElement('p');
        versionText.className = 'transcript-text transcript-version-text';
        const records = appendTimedText(versionText, version, referenceVersion);
        wordElements.push(...records);
        const viewport = document.createElement('div');
        viewport.className = 'lyrics-viewport';
        viewport.tabIndex = 0;
        viewport.setAttribute('role', 'region');
        viewport.setAttribute('aria-label', `${version.label} lyrics for ${partName}`);
        viewport.append(versionText);
        const follow = document.createElement('button');
        follow.type = 'button';
        follow.className = 'lyrics-follow';
        follow.textContent = 'Follow audio';
        follow.setAttribute('aria-label', `Follow audio in ${version.label.toLowerCase()} lyrics for ${partName}`);
        follow.hidden = true;
        const view = { panel, viewport, records, follow, following: true, currentLine: null, centeredLine: null };
        lyricViews.push(view);
        function stopFollowing() {
          view.following = false;
          follow.hidden = false;
          // Cancel an in-flight smooth scroll before the user's own gesture.
          viewport.scrollTo({ top: viewport.scrollTop, behavior: 'instant' });
        }
        function scrollKey(event) {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stopFollowing();
        }
        function pointerScroll(event) {
          if (event.target === viewport) stopFollowing();
        }
        viewport.addEventListener('wheel', stopFollowing, { passive: true });
        viewport.addEventListener('touchstart', stopFollowing, { passive: true });
        viewport.addEventListener('pointerdown', pointerScroll);
        viewport.addEventListener('keydown', scrollKey);
        follow.addEventListener('click', () => {
          view.following = true;
          follow.hidden = true;
          viewport.focus({ preventScroll: true });
          centerLyrics(view, true);
        });
        lyricCleanup.push(() => {
          viewport.removeEventListener('wheel', stopFollowing);
          viewport.removeEventListener('touchstart', stopFollowing);
          viewport.removeEventListener('pointerdown', pointerScroll);
          viewport.removeEventListener('keydown', scrollKey);
        });
        panel.append(viewport, follow);
        panels.push({ panel, heading: versionHeading });
        comparison.append(panel);
      });
      function updateComparison() {
        const useTabs = versions.length > 1;
        tabs.hidden = !useTabs;
        comparison.classList.toggle('uses-tabs', useTabs);
        panels.forEach(({ panel, heading: versionHeading }, panelIndex) => {
          const selected = panelIndex === selectedVersion;
          const tab = tabButtons[panelIndex];
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
          panel.hidden = useTabs && !selected;
          panel.setAttribute('role', useTabs ? 'tabpanel' : 'region');
          panel.setAttribute('aria-labelledby', useTabs ? tab.id : versionHeading.id);
          versionHeading.hidden = useTabs;
        });
      }
      updateComparison();
      transcript.append(tabs, comparison);
    } else {
      const text = document.createElement(cues.length ? 'div' : 'p');
      text.className = 'transcript-text';
      const hasTranscript = typeof part.transcript === 'string' && part.transcript.trim().length > 0;
      if (cues.length) {
        text.classList.add('transcript-cues');
        cues.forEach(cue => {
          const line = document.createElement('p');
          line.className = 'transcript-cue';
          line.textContent = cue.text;
          text.append(line);
          cueElements.push(line);
        });
      } else {
        text.textContent = hasTranscript ? part.transcript : 'Exact Voice Memos transcript not added yet.';
        text.classList.toggle('transcript-empty', !hasTranscript);
      }
      transcript.append(text);
    }
    transcript.append(...transcriptMetadata);
    article.append(player, transcript);
    list.append(article);

    let objectUrl = null;
    let loadPromise = null;
    let cancelLoad = null;
    let ready = false;
    let highlightedCue = -1;
    let animationFrame = 0;
    let disposed = false;
    const record = {
      audio,
      dispose() {
        disposed = true;
        stopTranscriptAnimation();
        lyricCleanup.forEach(cleanup => cleanup());
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

    function centerLyrics(view, force = false) {
      if (!ready || disposed || view.panel.hidden || !view.following) return;
      let line = view.currentLine;
      if (!line && force) {
        const prior = view.records.filter(item => item.word.start <= audio.currentTime);
        line = (prior[prior.length - 1] || view.records[0])?.line;
      }
      if (!line || (!force && view.centeredLine === line)) return;
      const lineBounds = line.getBoundingClientRect();
      const viewportBounds = view.viewport.getBoundingClientRect();
      const center = view.viewport.scrollTop + lineBounds.top - viewportBounds.top + lineBounds.height / 2;
      const maxScroll = Math.max(0, view.viewport.scrollHeight - view.viewport.clientHeight);
      view.viewport.scrollTo({
        top: Math.max(0, Math.min(maxScroll, center - view.viewport.clientHeight / 2)),
        behavior: reducedMotion.matches ? 'instant' : 'smooth'
      });
      view.centeredLine = line;
    }

    function resumeFollowing() {
      lyricViews.forEach(view => {
        view.following = true;
        view.follow.hidden = true;
        centerLyrics(view, true);
      });
    }

    function updateTranscript() {
      const next = ready && !audio.ended ? activeCueIndex(cues, audio.currentTime) : -1;
      if (next !== highlightedCue) {
        if (highlightedCue >= 0) {
          cueElements[highlightedCue].classList.remove('is-current');
          cueElements[highlightedCue].removeAttribute('aria-current');
        }
        if (next >= 0) {
          cueElements[next].classList.add('is-current');
          cueElements[next].setAttribute('aria-current', 'true');
        }
        highlightedCue = next;
      }
      const seconds = ready ? audio.currentTime : -1;
      wordElements.forEach(record => {
        const progress = wordProgress(record.word, seconds);
        const current = ready && !audio.ended && seconds >= record.word.start && seconds < record.word.end;
        const emphasized = current && !audio.paused && record.word.emphasized;
        if (progress !== record.progress) {
          record.span.style.setProperty('--word-fill', `${(progress * 100).toFixed(3)}%`);
          record.progress = progress;
        }
        if (current !== record.current) {
          record.span.classList.toggle('is-current-word', current);
          if (current) record.span.setAttribute('aria-current', 'true');
          else record.span.removeAttribute('aria-current');
          record.current = current;
        }
        if (emphasized !== record.emphasized) {
          record.span.classList.toggle('is-key-active', emphasized);
          record.emphasized = emphasized;
        }
      });
      lyricViews.forEach(view => {
        const line = view.records.find(item => item.current)?.line || null;
        if (view.currentLine !== line) {
          view.currentLine?.classList.remove('is-active-line');
          line?.classList.add('is-active-line');
          view.currentLine = line;
        }
        if (!audio.paused && !audio.ended) centerLyrics(view);
      });
    }

    function stopTranscriptAnimation() {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }

    function animateTranscript() {
      animationFrame = 0;
      if (disposed || session !== activeSession) return;
      updateTranscript();
      if (ready && !audio.paused && !audio.ended) animationFrame = requestAnimationFrame(animateTranscript);
    }

    function startTranscriptAnimation() {
      if (wordElements.length && !animationFrame && !disposed && !audio.paused && !audio.ended) {
        animationFrame = requestAnimationFrame(animateTranscript);
      }
    }

    function updatePosition() {
      const current = audio.currentTime || 0;
      seek.value = String(current);
      elapsed.textContent = formatTime(current);
      seek.setAttribute('aria-valuetext', `${formatTime(current)} of ${formatTime(audio.duration)}`);
      updateTranscript();
    }

    function setPosition(position) {
      if (!ready) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration || 0, position));
      updatePosition();
      resumeFollowing();
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
    audio.addEventListener('seeking', updatePosition);
    audio.addEventListener('seeked', updatePosition);
    audio.addEventListener('pause', () => {
      stopTranscriptAnimation();
      updateButton();
      updateTranscript();
    });
    audio.addEventListener('ended', () => {
      stopTranscriptAnimation();
      updateButton();
      updateTranscript();
    });
    audio.addEventListener('play', () => {
      players.forEach(other => { if (other !== record) other.audio.pause(); });
      updateButton();
      updateTranscript();
      resumeFollowing();
      startTranscriptAnimation();
    });
    audio.addEventListener('error', () => {
      if (!ready || session !== activeSession) return;
      ready = false;
      stopTranscriptAnimation();
      seek.disabled = true;
      seekButtons.forEach(button => { button.disabled = true; });
      status.textContent = 'Playback failed. Press play to load the audio again.';
      status.classList.add('is-error');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      updateButton();
      updateTranscript();
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
