(function () {
  'use strict';
  const element = document.getElementById('birthday-messages');
  if (!element || !window.BirthdayMessages) return;
  window.BirthdayMessages.mount(element, {
    endpoint: 'https://dashboard.oluwaseuno.com/api/birthday-messages'
  });
})();
