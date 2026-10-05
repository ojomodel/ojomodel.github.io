(() => {
  const sectionId = document.body.dataset.landingSection || document.documentElement.dataset.landingSection;
  const section = sectionId && document.getElementById(sectionId);
  const navigation = performance.getEntriesByType('navigation')[0];

  // Explicit anchors and history traversal keep the browser's own destination.
  if (!section || location.hash || navigation?.type === 'back_forward') return;

  let cancelled = false;
  const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'scroll', 'hashchange', 'pagehide'];
  const cancel = () => {
    cancelled = true;
    removeListeners();
  };
  const onPageShow = event => {
    if (event.persisted) cancel();
  };
  function removeListeners() {
    inputEvents.forEach(type => window.removeEventListener(type, cancel));
    window.removeEventListener('pageshow', onPageShow);
  }
  // Do not pull someone back after they have already started using the page.
  inputEvents.forEach(type => window.addEventListener(type, cancel, { passive: true }));
  window.addEventListener('pageshow', onPageShow);

  async function land() {
    if (document.readyState !== 'complete') {
      await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    }
    if (document.fonts) await document.fonts.ready.catch(() => {});
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (cancelled || location.hash || !section.isConnected) return;
    removeListeners();

    // Keep the existing responsive scroll-padding for the sticky header, but
    // suppress smooth scrolling for this one initial route landing.
    const rootStyle = document.documentElement.style;
    const previousBehavior = rootStyle.getPropertyValue('scroll-behavior');
    const previousPriority = rootStyle.getPropertyPriority('scroll-behavior');
    rootStyle.setProperty('scroll-behavior', 'auto', 'important');
    section.scrollIntoView({ behavior: 'auto', block: 'start' });

    // Put keyboard and screen-reader navigation at the same named section.
    const hadTabIndex = section.hasAttribute('tabindex');
    if (!hadTabIndex) section.setAttribute('tabindex', '-1');
    section.focus({ preventScroll: true });
    if (!hadTabIndex) {
      section.addEventListener('blur', () => section.removeAttribute('tabindex'), { once: true });
    }
    document.documentElement.dataset.landedSection = sectionId;
    requestAnimationFrame(() => {
      if (previousBehavior) rootStyle.setProperty('scroll-behavior', previousBehavior, previousPriority);
      else rootStyle.removeProperty('scroll-behavior');
    });
  }

  void land();
})();
