(function () {
  'use strict';
  const list = document.querySelector('.birthday-list');
  if (!list || !window.BirthdayClaims) return;
  window.BirthdayClaims.mount(list, {
    endpoint: 'https://dashboard.oluwaseuno.com/api/birthday-claims'
  });
})();
