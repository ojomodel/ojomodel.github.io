(function (global, factory) {
  const api = factory(global);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global && global.document) global.BirthdayReorder = api;
})(typeof window === 'undefined' ? null : window, function (global) {
  'use strict';

  function mergeOrder(currentIds, savedIds) {
    const current = [...new Set(currentIds.filter(id => typeof id === 'string' && id))];
    const available = new Set(current);
    const saved = Array.isArray(savedIds) ? savedIds : [];
    const ordered = [...new Set(saved.filter(id => available.has(id)))];
    return ordered.concat(current.filter(id => !ordered.includes(id)));
  }

  function moveOrder(order, id, index) {
    if (!order.includes(id) || !Number.isInteger(index)) return order.slice();
    const next = order.filter(item => item !== id);
    next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
    return next;
  }

  function equalOrder(first, second) {
    return first.length === second.length && first.every((id, index) => id === second[index]);
  }

  function mount(list, options = {}) {
    if (!list || !list.ownerDocument) throw new TypeError('A birthday list element is required.');
    const document = list.ownerDocument;
    const window = document.defaultView || global;
    const units = [...list.children].filter(node => node.matches('.gift-row[id], .gift-choice[id]'));
    const canonical = units.map(node => node.id);
    if (new Set(canonical).size !== canonical.length) throw new Error('Birthday item IDs must be unique.');
    const nodes = new Map(units.map(node => [node.id, node]));
    let order = canonical.slice();
    let draft = order.slice();
    let revision = options.revision ?? null;
    let draftRevision = revision;
    let persistence = options.persistence || {};
    let editable = options.editable === true;
    let opened = false;
    let saving = false;
    let destroyed = false;
    let loadSequence = 0;
    let drag = null;
    let conflict = null;
    let saveSequence = 0;

    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function button(className, text, label) {
      const node = element('button', className, text);
      node.type = 'button';
      if (label) node.setAttribute('aria-label', label);
      return node;
    }

    const toolbar = element('div', 'birthday-reorder-toolbar');
    const openButton = button('birthday-reorder-open', 'Reorder list');
    const status = element('p', 'birthday-reorder-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(openButton, status);
    const editor = element('section', 'birthday-reorder-editor');
    editor.hidden = true;
    editor.setAttribute('aria-label', 'Reorder birthday wishes');
    const header = element('div', 'birthday-reorder-header');
    const heading = element('div', 'birthday-reorder-heading');
    heading.append(element('h2', '', 'Reorder list'), element('p', '', 'Most wanted first'));
    const done = button('birthday-reorder-done', 'Done');
    header.append(heading, done);
    const stage = element('div', 'birthday-reorder-stage');
    const compactList = element('ol', 'birthday-reorder-items');
    const marker = element('div', 'birthday-reorder-marker');
    marker.hidden = true;
    marker.setAttribute('aria-hidden', 'true');
    stage.append(compactList, marker);
    const recovery = element('div', 'birthday-reorder-recovery');
    recovery.hidden = true;
    const reloadButton = button('birthday-reorder-reload', 'Load latest order');
    recovery.append(reloadButton);
    editor.append(header, stage, recovery);
    list.before(toolbar, editor);
    const rows = new Map();
    const titles = new Map();

    units.forEach(unit => {
      const name = unit.querySelector('.gift-choice-title, .gift-title')?.textContent.trim() || unit.id;
      titles.set(unit.id, name);
      const row = element('li', 'birthday-reorder-item');
      row.dataset.itemId = unit.id;
      const handle = button('birthday-reorder-handle', '⠿', 'Drag to move ' + name);
      handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
      const photo = unit.querySelector('.gift-image img');
      if (photo) {
        const image = document.createElement('img');
        image.src = photo.getAttribute('src');
        image.alt = '';
        image.width = 52;
        image.height = 52;
        image.loading = 'lazy';
        image.draggable = false;
        row.append(image);
      }
      const title = element('span', 'birthday-reorder-name', name);
      const number = element('span', 'birthday-reorder-number');
      number.setAttribute('aria-hidden', 'true');
      const controls = element('div', 'birthday-reorder-moves');
      const up = button('birthday-reorder-up', '↑', 'Move ' + name + ' up');
      const down = button('birthday-reorder-down', '↓', 'Move ' + name + ' down');
      controls.append(up, down);
      row.prepend(handle);
      row.append(title, number, controls);
      rows.set(unit.id, row);
      compactList.append(row);
      up.addEventListener('click', () => moveDraft(unit.id, draft.indexOf(unit.id) - 1));
      down.addEventListener('click', () => moveDraft(unit.id, draft.indexOf(unit.id) + 1));
      handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        moveDraft(unit.id, draft.indexOf(unit.id) + (event.key === 'ArrowUp' ? -1 : 1));
      });
      handle.addEventListener('pointerdown', event => startDrag(event, unit.id, handle));
    });

    function dirty() { return !equalOrder(draft, order); }

    function renderDraft() {
      const focused = document.activeElement;
      draft.forEach((id, index) => {
        const row = rows.get(id);
        compactList.append(row);
        row.querySelector('.birthday-reorder-number').textContent = String(index + 1);
        row.querySelector('.birthday-reorder-handle').disabled = saving;
        row.querySelector('.birthday-reorder-up').disabled = saving || index === 0;
        row.querySelector('.birthday-reorder-down').disabled = saving || index === draft.length - 1;
      });
      done.disabled = saving;
      done.textContent = saving ? 'Saving…' : 'Done';
      editor.setAttribute('aria-busy', String(saving));
      if (focused && editor.contains(focused)) {
        const target = focused.disabled ? focused.closest('li')?.querySelector('.birthday-reorder-handle') : focused;
        if (target && !target.disabled) target.focus({ preventScroll: true });
      }
    }

    function applyOrder(next, nextRevision = revision) {
      order = mergeOrder(canonical, next);
      revision = nextRevision;
      order.forEach(id => list.append(nodes.get(id)));
      if (!opened) { draft = order.slice(); draftRevision = revision; }
    }

    function moveDraft(id, index) {
      if (!opened || saving || !editable) return;
      const next = moveOrder(draft, id, index);
      if (equalOrder(next, draft)) return;
      draft = next;
      status.textContent = titles.get(id) + ', position ' + (draft.indexOf(id) + 1) + ' of ' + draft.length + '. Select Done to save.';
      renderDraft();
    }

    function open() {
      if (!editable || saving || destroyed) return false;
      draft = order.slice();
      draftRevision = revision;
      conflict = null;
      recovery.hidden = true;
      opened = true;
      list.hidden = true;
      editor.hidden = false;
      openButton.hidden = true;
      status.textContent = 'Drag a handle or use the arrow buttons. Select Done to save.';
      renderDraft();
      done.focus({ preventScroll: true });
      editor.scrollIntoView({ block: 'start' });
      return true;
    }

    function close() {
      if (saving) return false;
      cancelDrag();
      opened = false;
      editor.hidden = true;
      list.hidden = false;
      openButton.hidden = !editable;
      openButton.focus({ preventScroll: true });
      return true;
    }

    async function save() {
      if (saving || !editable) return;
      if (!dirty()) { close(); return; }
      if (typeof persistence.save !== 'function') {
        status.textContent = 'Your changes are here. Saving is currently unavailable.';
        return;
      }
      cancelDrag();
      saving = true;
      loadSequence += 1;
      const sequence = ++saveSequence;
      const requested = draft.slice();
      status.textContent = 'Saving order…';
      renderDraft();
      try {
        const result = await persistence.save(requested.slice(), { revision: draftRevision });
        if (destroyed || sequence !== saveSequence) return;
        if (result === false) throw new Error('The order was not saved.');
        const savedOrder = Array.isArray(result) ? result : result?.order || requested;
        applyOrder(savedOrder, result?.revision ?? revision);
        draft = order.slice();
        draftRevision = revision;
        saving = false;
        conflict = null;
        recovery.hidden = true;
        status.textContent = persistence.label || 'Order saved.';
        renderDraft();
        close();
        list.dispatchEvent(new window.CustomEvent('birthday-order-change', {
          bubbles: true, detail: { order: order.slice(), revision, source: 'editor', persisted: true }
        }));
      } catch (error) {
        if (destroyed || sequence !== saveSequence) return;
        saving = false;
        if (error?.code === 'conflict') {
          conflict = { order: error.latestOrder || error.order, revision: error.latestRevision ?? error.revision };
          recovery.hidden = false;
          status.textContent = 'The list changed elsewhere. Your changes are still here. Load the latest order to start again.';
        } else {
          status.textContent = persistence.failureLabel || 'Could not save. Your changes are still here. Select Done to try again.';
        }
        renderDraft();
        list.dispatchEvent(new window.CustomEvent('birthday-order-error', {
          bubbles: true, detail: { code: error?.code || 'save-failed', order: requested.slice(), error }
        }));
      }
    }

    function updateDrag() {
      if (!drag?.active) return;
      const others = draft.filter(id => id !== drag.id).map(id => rows.get(id));
      drag.target = others.filter(row => drag.y > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2).length;
      const following = others[drag.target];
      const edge = following ? following.getBoundingClientRect().top : others.at(-1)?.getBoundingClientRect().bottom;
      marker.style.top = ((edge ?? stage.getBoundingClientRect().top) - stage.getBoundingClientRect().top) + 'px';
      marker.hidden = false;
      drag.ghost.style.top = (drag.y - drag.offset) + 'px';
    }

    function scrollDrag() {
      if (!drag?.active) return;
      const edge = 84;
      let speed = 0;
      if (drag.y < edge) speed = -Math.ceil((edge - drag.y) / 5);
      if (drag.y > window.innerHeight - edge) speed = Math.ceil((drag.y - window.innerHeight + edge) / 5);
      if (speed) window.scrollBy(0, Math.max(-22, Math.min(22, speed)));
      updateDrag();
      drag.frame = window.requestAnimationFrame(scrollDrag);
    }

    function startDrag(event, id, handle) {
      if (!editable || saving || drag || event.isPrimary === false || event.button > 0) return;
      const row = rows.get(id);
      const bounds = row.getBoundingClientRect();
      drag = { id, handle, pointerId: event.pointerId, startY: event.clientY, y: event.clientY,
        offset: event.clientY - bounds.top, target: draft.indexOf(id), active: false, ghost: null, frame: null };
      handle.setPointerCapture(event.pointerId);
      handle.addEventListener('pointermove', movePointer);
      handle.addEventListener('pointerup', finishPointer);
      handle.addEventListener('pointercancel', cancelDrag);
      handle.addEventListener('lostpointercapture', cancelDrag);
      event.preventDefault();
    }

    function movePointer(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.y = event.clientY;
      if (!drag.active && Math.abs(drag.y - drag.startY) >= 5) {
        drag.active = true;
        const row = rows.get(drag.id);
        const bounds = row.getBoundingClientRect();
        drag.ghost = row.cloneNode(true);
        drag.ghost.classList.add('birthday-reorder-ghost');
        drag.ghost.setAttribute('aria-hidden', 'true');
        drag.ghost.inert = true;
        drag.ghost.style.width = bounds.width + 'px';
        drag.ghost.style.left = bounds.left + 'px';
        document.body.append(drag.ghost);
        row.classList.add('birthday-reorder-origin');
        document.documentElement.classList.add('birthday-reordering');
        drag.frame = window.requestAnimationFrame(scrollDrag);
      }
      updateDrag();
      event.preventDefault();
    }

    function finishPointer(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { id, target, active } = drag;
      cancelDrag();
      if (active) moveDraft(id, target);
      rows.get(id).querySelector('.birthday-reorder-handle').focus({ preventScroll: true });
    }

    function cancelDrag() {
      if (!drag) return;
      const current = drag;
      drag = null;
      current.handle.removeEventListener('pointermove', movePointer);
      current.handle.removeEventListener('pointerup', finishPointer);
      current.handle.removeEventListener('pointercancel', cancelDrag);
      current.handle.removeEventListener('lostpointercapture', cancelDrag);
      if (current.frame) window.cancelAnimationFrame(current.frame);
      if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
      current.ghost?.remove();
      rows.get(current.id).classList.remove('birthday-reorder-origin');
      marker.hidden = true;
      document.documentElement.classList.remove('birthday-reordering');
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        const handle = drag.handle;
        cancelDrag();
        status.textContent = 'Move cancelled.';
        handle.focus({ preventScroll: true });
      }
    }

    async function load() {
      const sequence = ++loadSequence;
      if (typeof persistence.load !== 'function') return;
      const result = await persistence.load();
      if (destroyed || sequence !== loadSequence) return;
      const latest = Array.isArray(result) ? result : result?.order;
      if (!Array.isArray(latest)) return;
      const hasDraft = opened && dirty();
      applyOrder(latest, result?.revision ?? null);
      if (opened && !hasDraft) {
        draft = order.slice();
        draftRevision = revision;
        renderDraft();
      }
      if (hasDraft) {
        conflict = { order: order.slice(), revision };
        recovery.hidden = false;
        status.textContent = 'The shared order changed. Your changes are still here.';
      }
    }

    openButton.addEventListener('click', open);
    done.addEventListener('click', save);
    document.addEventListener('keydown', onKeyDown);
    reloadButton.addEventListener('click', async () => {
      if (saving) return;
      try {
        if (Array.isArray(conflict?.order)) applyOrder(conflict.order, conflict.revision ?? revision);
        else await load();
        draft = order.slice();
        draftRevision = revision;
        conflict = null;
        recovery.hidden = true;
        status.textContent = 'Latest order loaded.';
        renderDraft();
      } catch (_) {
        status.textContent = 'Could not load the latest order. Your changes are still here.';
      }
    });
    openButton.hidden = !editable;
    renderDraft();
    const controller = {
      getOrder: () => order.slice(),
      getState: () => ({ order: order.slice(), draft: draft.slice(), revision, draftRevision, editable, opened, saving, dirty: dirty() }),
      setOrder(next, nextRevision) {
        loadSequence += 1;
        const hasDraft = opened && dirty();
        applyOrder(next, nextRevision);
        if (opened && !hasDraft) { draft = order.slice(); draftRevision = revision; renderDraft(); }
        if (hasDraft) { conflict = { order: order.slice(), revision }; recovery.hidden = false; status.textContent = 'The shared order changed. Your changes are still here.'; }
      },
      setEditable(value) {
        editable = value === true;
        openButton.hidden = !editable || opened;
        if (!editable && opened && !saving) close();
      },
      setPersistence(adapter) { persistence = adapter || {}; },
      open, close,
      destroy() {
        destroyed = true;
        loadSequence += 1;
        saveSequence += 1;
        cancelDrag();
        document.removeEventListener('keydown', onKeyDown);
        list.hidden = false;
        toolbar.remove();
        editor.remove();
      }
    };
    controller.ready = load().catch(error => {
      if (!destroyed) {
        status.textContent = 'Could not load saved order. Refresh to try again.';
        list.dispatchEvent(new window.CustomEvent('birthday-order-error', { bubbles: true, detail: { code: 'load-failed', error } }));
      }
    });
    return controller;
  }

  return { mount, mergeOrder, moveOrder };
});
