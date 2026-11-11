// DOM toolkit: element builder, keyed morph, and the layout animations that ride on it.

const SVG = 'http://www.w3.org/2000/svg';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) (el._on ??= {})[k] = el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const alive = (el) => el && !el._leaving;
const nextAlive = (el) => {
  do el = el.nextElementSibling;
  while (el && el._leaving);
  return el;
};

/**
 * Syncs `a` to look like `b` in place, so scroll, focus and running animations survive a refresh.
 * Children that carry data-key are matched by key: new ones enter, missing ones play an exit.
 */
export function morph(a, b) {
  sync(a, b);
  // Exits wait until the whole tree is in place: only then is it known whether an element moved or left.
  for (const el of departing.splice(0)) leave(el);
}

const departing = [];

function sync(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return a.replaceWith(b);
  if (a.nodeType === Node.TEXT_NODE) {
    if (a.data !== b.data) a.data = b.data;
    return;
  }
  if (a.nodeType !== Node.ELEMENT_NODE) return;
  const keep = a.dataset?.decided;
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && !(name === 'open' && a.nodeName === 'DETAILS') && !(name === 'style' && b.hasAttribute('data-keep-style'))) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (keep) a.dataset.decided = keep;
  for (const k in a._on ?? {}) a[k] = null;
  for (const k in b._on ?? {}) a[k] = b._on[k];
  a._on = b._on;
  if (a._num && !b.hasAttribute('data-num')) delete a._num;

  const fresh = [...b.childNodes];
  if (fresh.length && fresh.every((n) => n.nodeType === Node.ELEMENT_NODE && n.dataset.key)) {
    const old = new Map();
    for (const c of a.children) if (alive(c) && c.dataset.key) old.set(c.dataset.key, c);
    for (const c of [...a.childNodes]) if (c.nodeType !== Node.ELEMENT_NODE || (!c.dataset.key && alive(c))) c.remove();
    // Mark departures first, so the walk below treats them as absent and keeps the survivors in order.
    const staying = new Set(fresh.map((n) => n.dataset.key));
    for (const [key, el] of old) {
      if (staying.has(key)) continue;
      old.delete(key);
      depart(el);
    }
    let cursor = a.firstElementChild;
    if (cursor && !alive(cursor)) cursor = nextAlive(cursor);
    for (const nb of fresh) {
      const match = old.get(nb.dataset.key);
      if (match) {
        old.delete(nb.dataset.key);
        sync(match, nb);
        if (match === cursor) cursor = nextAlive(cursor);
        else a.insertBefore(match, cursor);
      } else {
        a.insertBefore(nb, cursor);
      }
    }
    return;
  }
  const current = [...a.childNodes].filter((n) => n.nodeType !== Node.ELEMENT_NODE || alive(n));
  fresh.forEach((child, i) => (current[i] ? sync(current[i], child) : a.append(child)));
  current.slice(fresh.length).forEach((n) => (n.nodeType === Node.ELEMENT_NODE && n.dataset.key ? depart(n) : n.remove()));
}

/** Marks an element as gone for this render. It stays in the DOM until `leave` decides how it exits. */
function depart(el) {
  el._leaving = true;
  departing.push(el);
}

/** Exit for a keyed element: fade out in place, then let the neighbours glide into the gap. */
function leave(el) {
  const moved = el.dataset.flip && [...document.querySelectorAll(`[data-flip="${el.dataset.flip}"]`)].some((o) => o !== el && !o._leaving);
  if (reduced.matches || moved || !el.isConnected) return el.remove();
  el._leaving = true;
  el.style.pointerEvents = 'none';
  const delay = el.dataset.decided ? 520 : 0;
  const anim = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 220, delay, easing: 'ease-in', fill: 'forwards' });
  anim.onfinish = anim.oncancel = () => flip(() => el.remove());
}

/**
 * FLIP. Records where every [data-flip] element sits, runs `mutate`, then animates each element
 * from its old spot to its new one. An element that changes parents (a ticket moving lanes)
 * keeps its id, so it travels across.
 */
export function flip(mutate) {
  if (reduced.matches) return mutate();
  const before = new Map();
  for (const el of document.querySelectorAll('[data-flip]')) if (alive(el)) before.set(el.dataset.flip, el.getBoundingClientRect());
  mutate();
  for (const el of document.querySelectorAll('[data-flip]')) {
    if (!alive(el)) continue;
    const from = before.get(el.dataset.flip);
    if (!from) continue;
    el._flip?.cancel();
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (Math.abs(dy) > innerHeight * 1.5) continue;
    // It existed before this render, so its entrance animation must not replay.
    for (const running of el.getAnimations()) if (running instanceof CSSAnimation) running.finish();
    const travelled = Math.hypot(dx, dy);
    el._flip = el.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 2 }, { transform: 'none', zIndex: 2 }], { duration: Math.min(620, 320 + travelled * 0.5), easing: EASE });
  }
}

const FORMAT = {
  int: (n) => String(Math.round(n)),
  usd: (n) => `$${n.toFixed(2)}`,
  pct: (n) => `${Math.round(n)}%`,
};

/** Rolls every [data-num] element from the number it shows to its new value. */
export function rollNumbers(root = document) {
  for (const el of root.querySelectorAll('[data-num]')) {
    const target = Number(el.dataset.num);
    const fmt = FORMAT[el.dataset.fmt || 'int'];
    const state = (el._num ??= { shown: 0, target: null });
    if (state.target === target) {
      if (!state.raf) el.textContent = fmt(target);
      continue;
    }
    state.target = target;
    cancelAnimationFrame(state.raf);
    if (reduced.matches) {
      state.shown = target;
      el.textContent = fmt(target);
      continue;
    }
    const from = state.shown;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 600);
      state.shown = from + (target - from) * (1 - (1 - k) ** 3);
      el.textContent = fmt(state.shown);
      state.raf = k < 1 ? requestAnimationFrame(step) : null;
    };
    el.textContent = fmt(from);
    state.raf = requestAnimationFrame(step);
  }
}

/** Slides a highlight pill under the active item of a nav or tab strip. */
export function placePill(container) {
  const pill = container?.querySelector(':scope > .pill');
  if (!pill) return;
  const active = container.querySelector('[aria-current="page"], [aria-selected="true"]');
  if (!active) return void (pill.style.opacity = '0');
  const first = pill.style.opacity !== '1';
  if (first) pill.style.transition = 'none';
  pill.style.opacity = '1';
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.height = `${active.offsetHeight}px`;
  pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (first) requestAnimationFrame(() => (pill.style.transition = ''));
}
