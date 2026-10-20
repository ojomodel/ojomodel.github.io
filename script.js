(() => {
  "use strict";

  document.documentElement.dataset.motion = "full";
  const reveals = [...document.querySelectorAll(".reveal")];
  const intersections = new WeakMap();
  const initialTransitions = new Map();
  let revealObserver;
  let revealFrame;
  let revealGeneration = 0;

  function updateReveal(element) {
    const visible = intersections.get(element) || element.contains(document.activeElement);
    element.classList.toggle("is-visible", Boolean(visible));
  }

  function restoreRevealTransitions() {
    initialTransitions.forEach(({ value, priority }, element) => {
      if (value) element.style.setProperty("transition", value, priority);
      else element.style.removeProperty("transition");
    });
    initialTransitions.clear();
  }

  function configureReveals() {
    const generation = ++revealGeneration;
    let primed = false;
    cancelAnimationFrame(revealFrame);
    revealObserver?.disconnect();
    revealObserver = null;
    restoreRevealTransitions();
    reveals.forEach((element) => element.classList.remove("reveal-ready"));
    if (!("IntersectionObserver" in window)) {
      reveals.forEach((element) => element.classList.add("is-visible"));
      return;
    }

    revealObserver = new IntersectionObserver((entries) => {
      if (generation !== revealGeneration) return;
      entries.forEach(({ target, isIntersecting }) => {
        intersections.set(target, isIntersecting);
        if (primed) updateReveal(target);
      });
    }, { threshold: 0 });

    reveals.forEach((element) => {
      const bounds = element.getBoundingClientRect();
      intersections.set(element, bounds.bottom > 0 && bounds.top < window.innerHeight);
      revealObserver.observe(element);
      initialTransitions.set(element, {
        value: element.style.getPropertyValue("transition"),
        priority: element.style.getPropertyPriority("transition")
      });
      element.style.setProperty("transition", "none", "important");
      element.classList.toggle("is-visible", element.contains(document.activeElement));
      element.classList.add("reveal-ready");
    });

    // Paint the starting state before revealing content already in the viewport.
    revealFrame = requestAnimationFrame(() => {
      revealFrame = requestAnimationFrame(() => {
        if (generation !== revealGeneration) return;
        restoreRevealTransitions();
        primed = true;
        reveals.forEach(updateReveal);
      });
    });
  }

  reveals.forEach((element) => {
    element.addEventListener("focusin", () => element.classList.add("is-visible"));
    element.addEventListener("focusout", () => {
      requestAnimationFrame(() => {
        if (revealObserver) updateReveal(element);
      });
    });
  });
  configureReveals();

  document.querySelectorAll("[data-gallery]").forEach((gallery, galleryIndex) => {
    const tabList = gallery.querySelector(".gallery-tabs");
    const panels = [...gallery.querySelectorAll("[data-gallery-panel]")];
    const tabs = [...gallery.querySelectorAll("[data-gallery-tab]")].filter((tab) =>
      panels.some((panel) => panel.id === tab.getAttribute("aria-controls"))
    );
    if (!tabList || !tabs.length) return;

    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-orientation", "horizontal");
    if (!tabList.hasAttribute("aria-label") && !tabList.hasAttribute("aria-labelledby")) {
      tabList.setAttribute("aria-label", "Project media");
    }

    function activateTab(selected, moveFocus = false) {
      const selectedPanel = document.getElementById(selected.getAttribute("aria-controls"));
      const wouldHideFocus = panels.some((panel) =>
        panel !== selectedPanel && panel.contains(document.activeElement)
      );
      if (moveFocus || wouldHideFocus) selected.focus({ preventScroll: true });
      tabs.forEach((tab) => {
        const active = tab === selected;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        tab.classList.toggle("is-active", active);
      });
      panels.forEach((panel) => { panel.hidden = panel !== selectedPanel; });
    }

    tabs.forEach((tab, index) => {
      if (!tab.id) tab.id = `project-media-tab-${galleryIndex + 1}-${index + 1}`;
      tab.setAttribute("role", "tab");
      if (tab.tagName === "BUTTON") tab.type = "button";
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      panel.tabIndex = 0;
      tab.addEventListener("click", () => activateTab(tab, true));
      tab.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        activateTab(tabs[next], true);
      });
    });
    activateTab(tabs[0]);
    gallery.classList.add("gallery-enhanced");
  });

  const header = document.querySelector(".site-header");
  const menuToggle = document.getElementById("menu-toggle");
  const nav = document.getElementById("site-nav");
  const navDropdowns = [...(nav?.querySelectorAll(".nav-projects") || [])];

  function closeDropdown(dropdown, returnFocus = false) {
    if (!dropdown.open) return;
    dropdown.open = false;
    if (returnFocus) dropdown.querySelector("summary").focus({ preventScroll: true });
  }

  function closeDropdowns(returnFocus = false) {
    const openDropdowns = navDropdowns.filter((dropdown) => dropdown.open);
    openDropdowns.forEach((dropdown, index) => closeDropdown(dropdown, returnFocus && index === 0));
  }

  document.addEventListener("click", (event) => {
    navDropdowns.forEach((dropdown) => {
      if (!dropdown.contains(event.target)) closeDropdown(dropdown);
    });
  });
  navDropdowns.forEach((dropdown) => {
    dropdown.addEventListener("focusout", (event) => {
      if (event.relatedTarget && !dropdown.contains(event.relatedTarget)) closeDropdown(dropdown);
    });
    dropdown.addEventListener("toggle", () => {
      if (dropdown.open) navDropdowns.forEach((other) => {
        if (other !== dropdown) closeDropdown(other);
      });
    });
  });

  function localTarget(link) {
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !url.hash) return null;
    try {
      return document.getElementById(decodeURIComponent(url.hash.slice(1)));
    } catch {
      return null;
    }
  }

  if (header && menuToggle && nav) {
    menuToggle.setAttribute("aria-controls", nav.id);
    menuToggle.setAttribute("aria-expanded", "false");
    header.classList.add("nav-enhanced");

    function closeMenu(returnFocus = false) {
      closeDropdowns();
      if (returnFocus) menuToggle.focus({ preventScroll: true });
      header.classList.remove("menu-open");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Open navigation menu");
    }

    menuToggle.addEventListener("click", () => {
      const open = menuToggle.getAttribute("aria-expanded") !== "true";
      if (!open) closeDropdowns();
      menuToggle.setAttribute("aria-expanded", String(open));
      menuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
      header.classList.toggle("menu-open", open);
    });
    header.querySelector(".site-brand")?.addEventListener("click", () => closeMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (navDropdowns.some((dropdown) => dropdown.open)) {
        event.preventDefault();
        closeDropdowns(true);
      } else if (menuToggle.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        closeMenu(true);
      }
    });
    nav.querySelectorAll("a[href]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
        const target = localTarget(link);
        if (!target || menuToggle.getAttribute("aria-expanded") !== "true") {
          closeMenu();
          return;
        }
        const focusTarget = target.querySelector("h1, h2, h3") || target;
        const addedTabIndex = !focusTarget.hasAttribute("tabindex");
        if (addedTabIndex) focusTarget.setAttribute("tabindex", "-1");
        focusTarget.focus({ preventScroll: true });
        if (addedTabIndex) focusTarget.addEventListener("blur", () => focusTarget.removeAttribute("tabindex"), { once: true });
        closeMenu();
      });
    });
  }

  if (nav && "IntersectionObserver" in window) {
    const sectionLinks = [...nav.querySelectorAll("a[href], [data-nav-section]")]
      .map((link) => ({ link, section: link.dataset.navSection ? document.getElementById(link.dataset.navSection) : localTarget(link) }))
      .filter(({ section }) => section?.matches("section[id][data-section]"));
    const visibleSections = new Set();
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) visibleSections.add(target);
        else visibleSections.delete(target);
      });
      const active = [...visibleSections].sort((a, b) =>
        Math.abs(a.getBoundingClientRect().top - window.innerHeight * 0.2) -
        Math.abs(b.getBoundingClientRect().top - window.innerHeight * 0.2)
      )[0];
      sectionLinks.forEach(({ link, section }) => {
        const current = section === active;
        link.classList.toggle("is-active", current);
        if (current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }, { rootMargin: "-10% 0px -55% 0px", threshold: 0 });
    new Set(sectionLinks.map(({ section }) => section)).forEach((section) => sectionObserver.observe(section));
  }
})();
