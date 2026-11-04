(function () {
  'use strict';
  function openLinkedProduct() {
    const fragment = location.hash.slice(1);
    if (!fragment || fragment.includes('=')) return;
    let target;
    try { target = document.getElementById(decodeURIComponent(fragment)); } catch (_) { return; }
    const details = target?.closest('.gift-bundle-products');
    if (!details) return;
    details.open = true;
    target.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('hashchange', openLinkedProduct);
  const ready = window.birthdayPriorityController?.ready;
  if (ready && typeof ready.then === 'function') ready.then(openLinkedProduct).catch(function () { /* Existing links still work offline. */ });
  else openLinkedProduct();
})();
