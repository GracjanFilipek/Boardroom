import { icon } from './pixels.js';

// Spring motion and the sheet component. Springs start from the live value and carry
// velocity, so a sheet can be grabbed or re-targeted mid-flight without a jump.

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const compact = matchMedia('(max-width: 760px)');

/**
 * Damped spring on one value. `response` is seconds to reach the target, `damping` 1 means no overshoot.
 * Returns a handle whose `value` and `velocity` stay current, so a caller can interrupt and hand both on.
 */
export function spring({ from, to, velocity = 0, response = 0.35, damping = 1, onUpdate, onDone }) {
  const stiffness = (2 * Math.PI / response) ** 2;
  const friction = (4 * Math.PI * damping) / response;
  const handle = { value: from, velocity, stopped: false, stop: () => (handle.stopped = true) };
  if (reduced.matches) {
    handle.value = to;
    handle.velocity = 0;
    onUpdate(to);
    onDone?.();
    return handle;
  }
  let last = performance.now();
  const frame = (t) => {
    if (handle.stopped) return;
    let dt = Math.min(0.064, (t - last) / 1000);
    last = t;
    // Fixed 4 ms steps keep the integration stable when a frame runs long.
    while (dt > 0) {
      const step = Math.min(dt, 0.004);
      const accel = -stiffness * (handle.value - to) - friction * handle.velocity;
      handle.velocity += accel * step;
      handle.value += handle.velocity * step;
      dt -= step;
    }
    if (Math.abs(handle.value - to) < 0.0005 && Math.abs(handle.velocity) < 0.005) {
      handle.value = to;
      onUpdate(to);
      handle.stopped = true;
      onDone?.();
      return;
    }
    onUpdate(handle.value);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return handle;
}

/** Where a flick comes to rest (exponential decay, the scroll-deceleration model). */
const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);
const rubberband = (overshoot, dimension, c = 0.55) => (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));

const open = [];

/**
 * Opens a sheet. On phones it rises from the bottom edge and follows the finger when dragged by
 * its header. On wider screens it materialises in the centre.
 * `p` is the closed fraction: 0 fully open, 1 fully closed.
 */
export function openSheet({ title, body, foot, wide = false, onClose }) {
  const host = document.getElementById('sheets');
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const el = document.createElement('section');
  el.className = `sheet${wide ? ' wide' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', title);

  const head = document.createElement('header');
  head.className = 'sheet-head';
  head.innerHTML = '<span class="grabber"></span><h2></h2><button class="btn quiet icon-only" aria-label="Close"></button>';
  head.querySelector('button').append(icon('x'));
  head.querySelector('h2').textContent = title;
  const bodyEl = Object.assign(document.createElement('div'), { className: 'sheet-body' });
  bodyEl.append(body);
  el.append(head, bodyEl);
  if (foot) {
    const footEl = Object.assign(document.createElement('footer'), { className: 'sheet-foot' });
    footEl.append(...foot);
    el.append(footEl);
  }
  host.append(scrim, el);

  let p = 1;
  let anim = null;
  let closed = false;
  const height = () => el.offsetHeight || 1;
  const paint = (v) => {
    p = v;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - v)));
    if (compact.matches) {
      el.style.opacity = '1';
      el.style.transform = `translateY(${v * height()}px)`;
    } else {
      el.style.opacity = String(Math.max(0, 1 - v));
      el.style.transform = `translateY(calc(-50% + ${v * 14}px)) scale(${1 - v * 0.04})`;
    }
  };
  const animate = (to, velocity = 0, bouncy = false) => {
    anim?.stop();
    anim = spring({
      from: p, to, velocity,
      response: 0.34, damping: bouncy ? 0.82 : 1,
      onUpdate: paint,
      onDone: () => to === 1 && destroy(),
    });
  };
  const destroy = () => {
    scrim.remove();
    el.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    open.splice(open.indexOf(api), 1);
    previous?.focus?.();
    animate(1);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && open.at(-1) === api) close();
  };

  // Drag the header to move the sheet. Release velocity decides where it lands.
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (!compact.matches || e.target.closest('button') || closed) return;
    head.setPointerCapture(e.pointerId);
    anim?.stop();
    drag = { startY: e.clientY, startP: p, h: height(), samples: [{ y: e.clientY, t: e.timeStamp }] };
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.samples.push({ y: e.clientY, t: e.timeStamp });
    if (drag.samples.length > 5) drag.samples.shift();
    let offset = drag.startP * drag.h + (e.clientY - drag.startY);
    if (offset < 0) offset = rubberband(offset, drag.h);
    paint(offset / drag.h);
  });
  const release = (e) => {
    if (!drag) return;
    const first = drag.samples[0];
    const dt = Math.max(1, e.timeStamp - first.t);
    const velocity = ((e.clientY - first.y) / dt) * 1000; // px/s, positive is downward
    const landing = p * drag.h + project(velocity);
    const h = drag.h;
    drag = null;
    if (landing > h * 0.5 && velocity >= 0) {
      closed = true;
      open.splice(open.indexOf(api), 1);
      animate(1, velocity / h);
    } else {
      animate(0, velocity / h, Math.abs(velocity) > 300);
    }
  };
  head.addEventListener('pointerup', release);
  head.addEventListener('pointercancel', release);

  head.querySelector('button').addEventListener('click', close);
  scrim.addEventListener('pointerdown', close);
  document.addEventListener('keydown', onKey);

  const previous = document.activeElement;
  const api = { el, body: bodyEl, close };
  open.push(api);
  paint(1);
  animate(0);
  (bodyEl.querySelector('input, textarea, select') ?? head.querySelector('button')).focus({ preventScroll: true });
  return api;
}
