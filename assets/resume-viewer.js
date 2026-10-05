// The original PDF is rendered locally; no resume text or imagery is rewritten.
let pdfLibrary;
const loadPdfLibrary = () => pdfLibrary ||= import('./vendor/pdfjs/pdf.mjs').then(pdfjs => {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  return pdfjs;
});

function prepareReader(reader) {
  const viewport = reader.querySelector('.resume-reader-viewport');
  const pages = reader.querySelector('.resume-reader-pages');
  const status = reader.querySelector('.resume-reader-status');
  const pageCount = reader.querySelector('.resume-reader-page');
  const scaleOutput = reader.querySelector('[data-resume-scale]');
  const controls = [...reader.querySelectorAll('[data-resume-zoom], [data-resume-fit]')];
  const source = reader.dataset.pdfUrl || '/resume.pdf';
  if (!viewport || !pages) return;

  let pdfjs, document, pageProxies = [], scale = 1, fitWidth = true;
  let started = false, generation = 0, resizeTimer, lastWidth = 0;
  const pending = new Set();
  controls.forEach(control => control.disabled = true);

  function showStatus(message, includeLink = false) {
    if (!status) return;
    status.replaceChildren(window.document.createTextNode(message));
    if (includeLink) {
      const link = window.document.createElement('a');
      link.href = source;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open PDF in a new tab ↗';
      status.append(window.document.createTextNode(' '), link);
    }
  }

  function fittedScale() {
    const width = Math.max(1, viewport.clientWidth - 2);
    const widestPage = Math.max(...pageProxies.map(page => page.getViewport({ scale: 1 }).width));
    return width / widestPage;
  }

  function updateControls() {
    if (scaleOutput) scaleOutput.textContent = `${Math.round(scale * 100)}%`;
    controls.forEach(control => {
      control.disabled = !document ||
        (control.dataset.resumeZoom === 'out' && scale <= .35) ||
        (control.dataset.resumeZoom === 'in' && scale >= 3);
      if (control.hasAttribute('data-resume-fit')) control.setAttribute('aria-pressed', String(fitWidth));
    });
  }

  function cancelPending() {
    for (const task of pending) task.cancel();
    pending.clear();
  }

  async function renderPages() {
    if (!document) return;
    const current = ++generation;
    cancelPending();
    if (fitWidth) scale = fittedScale();
    const renderScale = scale;
    const scrollFraction = viewport.scrollTop / Math.max(1, viewport.scrollHeight);
    const scrollCenter = (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(1, viewport.scrollWidth);
    updateControls();
    reader.setAttribute('aria-busy', 'true');
    const fragment = window.document.createDocumentFragment();

    try {
      for (const page of pageProxies) {
        if (current !== generation) return;
        const pageViewport = page.getViewport({ scale: renderScale });
        const paper = window.document.createElement('div');
        paper.className = 'resume-reader-paper';
        paper.setAttribute('role', 'article');
        paper.setAttribute('aria-label', `Resume, page ${page.pageNumber} of ${document.numPages}`);
        paper.style.width = `${pageViewport.width}px`;
        paper.style.height = `${pageViewport.height}px`;
        paper.style.setProperty('--total-scale-factor', String(renderScale));
        paper.style.setProperty('--scale-round-x', '1px');
        paper.style.setProperty('--scale-round-y', '1px');

        const canvas = window.document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        // Limit unusually large displays/zoom levels without softening normal HiDPI text.
        const density = Math.min(window.devicePixelRatio || 1, 2.5,
          Math.sqrt(16000000 / (pageViewport.width * pageViewport.height)));
        canvas.width = Math.ceil(pageViewport.width * density);
        canvas.height = Math.ceil(pageViewport.height * density);
        canvas.style.width = `${pageViewport.width}px`;
        canvas.style.height = `${pageViewport.height}px`;
        paper.append(canvas);
        const renderTask = page.render({
          canvasContext: canvas.getContext('2d', { alpha: false }),
          viewport: pageViewport,
          transform: density === 1 ? null : [density, 0, 0, density, 0, 0],
          background: '#ffffff'
        });
        pending.add(renderTask);
        await renderTask.promise;
        pending.delete(renderTask);
        if (current !== generation) return;

        const text = window.document.createElement('div');
        text.className = 'textLayer';
        paper.append(text);
        const textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: text,
          viewport: pageViewport
        });
        pending.add(textLayer);
        await textLayer.render();
        pending.delete(textLayer);
        if (current !== generation) return;

        const links = window.document.createElement('div');
        links.className = 'resume-reader-links';
        const annotations = await page.getAnnotations({ intent: 'display' });
        for (const annotation of annotations) {
          if (annotation.subtype !== 'Link' || !annotation.url || !/^(https?:|mailto:|tel:)/i.test(annotation.url)) continue;
          if (!Array.isArray(annotation.rect) || annotation.rect.length !== 4) continue;
          const rect = [
            ...pageViewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
            ...pageViewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3])
          ];
          const link = window.document.createElement('a');
          link.href = annotation.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.setAttribute('aria-label', annotation.url.replace(/^mailto:|^https?:\/\//, ''));
          link.style.left = `${Math.min(rect[0], rect[2])}px`;
          link.style.top = `${Math.min(rect[1], rect[3])}px`;
          link.style.width = `${Math.abs(rect[2] - rect[0])}px`;
          link.style.height = `${Math.abs(rect[3] - rect[1])}px`;
          links.append(link);
        }
        paper.append(links);
        fragment.append(paper);
      }
      if (current !== generation) return;
      pages.replaceChildren(fragment);
      viewport.scrollTop = scrollFraction * viewport.scrollHeight;
      viewport.scrollLeft = Math.max(0, scrollCenter * viewport.scrollWidth - viewport.clientWidth / 2);
      reader.dataset.resumeReady = 'true';
      showStatus('Scroll to read.');
    } catch (error) {
      if (current !== generation || error.name === 'RenderingCancelledException' || error.name === 'AbortException') return;
      showStatus('The embedded preview could not load.', true);
      reader.dataset.resumeReady = 'error';
      console.warn('Resume preview:', error);
    } finally {
      if (current === generation) reader.setAttribute('aria-busy', 'false');
    }
  }

  async function start() {
    if (started) return;
    started = true;
    reader.setAttribute('aria-busy', 'true');
    try {
      pdfjs = await loadPdfLibrary();
      document = await pdfjs.getDocument({ url: source, isEvalSupported: false }).promise;
      pageProxies = await Promise.all(Array.from({ length: document.numPages }, (_, i) => document.getPage(i + 1)));
      if (pageCount) pageCount.textContent = `${document.numPages} ${document.numPages === 1 ? 'page' : 'pages'} · PDF`;
      lastWidth = viewport.clientWidth;
      await renderPages();
    } catch (error) {
      showStatus('The embedded preview could not load.', true);
      reader.dataset.resumeReady = 'error';
      reader.setAttribute('aria-busy', 'false');
      console.warn('Resume preview:', error);
    }
  }

  controls.forEach(control => control.addEventListener('click', () => {
    if (!document) return;
    fitWidth = control.hasAttribute('data-resume-fit');
    if (!fitWidth) scale = Math.min(3, Math.max(.35, scale + (control.dataset.resumeZoom === 'in' ? .2 : -.2)));
    renderPages();
  }));

  const resize = new ResizeObserver(() => {
    const width = viewport.clientWidth;
    if (!document || !fitWidth || Math.abs(lastWidth - width) < 1) return;
    lastWidth = width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPages, 120);
  });
  resize.observe(viewport);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        start();
      }
    }, { rootMargin: '400px 0px' });
    observer.observe(reader);
  } else start();
  if (window.document.body.dataset.landingSection === 'resume' || location.hash === '#resume') start();
}

window.document.querySelectorAll('[data-resume-reader]').forEach(prepareReader);
