(() => {
  // Keep previously shared project anchors useful after the page split.
  const projectHashes = new Set(['#arm-demo', '#arm-interactive', '#arm-prototypes', '#arm-redesign', '#prototypes-title', '#motor-arm', '#arm-design-details', '#arm-build-photos']);
  if (!document.body.classList.contains('arm-project-page')) {
    if (projectHashes.has(location.hash)) location.replace(`/projects/${location.hash}`);
    return;
  }
  function revealAnchor() {
    let target;
    try { target = document.querySelector(location.hash || '#top'); } catch { return; }
    if (!target) return;
    const disclosure = target.closest('details');
    if (disclosure) { disclosure.open = true; requestAnimationFrame(() => target.scrollIntoView()); }
  }
  revealAnchor();
  addEventListener('hashchange', revealAnchor);
  document.querySelectorAll('[data-gallery]').forEach(gallery => {
    new MutationObserver(() => {
      gallery.querySelectorAll('[data-gallery-panel][hidden] video').forEach(video => video.pause());
    }).observe(gallery, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
})();
