/*
 * Injected into every page during a recording. Draws what a screen recording of a real
 * person would show (a mouse pointer, click ripples) plus presentation layers: chapter
 * cards, a highlight ring and a small label. Lives in a shadow root so app styles can't
 * touch it, and never takes pointer events.
 */
(() => {
  if (window.__wt) return;
  const state = { x: -100, y: -100, queue: [] };
  let root;

  const css = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: Inter, "Inter Display", system-ui, -apple-system, "Segoe UI", sans-serif; }
    .cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-100px,-100px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    .ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(37,99,235,.85); background: rgba(37,99,235,.15); animation: ripple .55s ease-out forwards; }
    @keyframes ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
    .ring { position: absolute; border-radius: 12px; box-shadow: 0 0 0 4px rgba(245,158,11,.95), 0 0 0 9999px rgba(15,23,42,.28); transition: all .45s cubic-bezier(.2,.8,.2,1); opacity: 0; }
    .ring.on { opacity: 1; }
    .ring .tag { position: absolute; left: 0; top: calc(100% + 10px); background: #0f172a; color: #fff; font-size: 15px; font-weight: 600; padding: 7px 12px; border-radius: 8px; white-space: nowrap; }
    .card { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 0 9vw; background: radial-gradient(1200px 600px at 20% 30%, #1e3a5f 0%, #0b1220 60%); color: #f8fafc; opacity: 0; transition: opacity .6s ease; }
    .card.on { opacity: 1; }
    .card .eyebrow { font-size: 18px; letter-spacing: .14em; text-transform: uppercase; color: #93c5fd; font-weight: 600; margin-bottom: 18px; }
    .card .title { font-size: 56px; line-height: 1.08; font-weight: 700; max-width: 18ch; letter-spacing: -.02em; }
    .card .sub { margin-top: 22px; font-size: 22px; color: #cbd5e1; max-width: 46ch; line-height: 1.45; }
    .card .rule { width: 72px; height: 5px; border-radius: 3px; background: #f59e0b; margin-bottom: 26px; }
    .label { position: absolute; right: 18px; bottom: 18px; background: rgba(15,23,42,.88); color: #e2e8f0; font-size: 13px; padding: 7px 11px; border-radius: 8px; opacity: 0; transition: opacity .4s; }
    .label.on { opacity: 1; }
  `;

  const arrow =
    '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M4 2 L4 21 L9 16.5 L12.5 24 L16 22.5 L12.6 15.2 L19.5 15.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function mount() {
    if (root || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = '__wt-overlay';
    host.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${css}</style><div class="layer"><div class="ring"><span class="tag" hidden></span></div><div class="label"></div><div class="cursor">${arrow}</div><div class="card"><div class="rule"></div><div class="eyebrow"></div><div class="title"></div><div class="sub"></div></div></div>`;
    root = shadow.querySelector('.layer');
    place();
    // A chapter card that was up when the previous page navigated away stays up, with no fade.
    const carried = readCarried();
    if (carried) showCard(carried, false);
    // Pages that rebuild <html> children (rare) would drop the host; put it back.
    new MutationObserver(() => {
      if (!host.isConnected) document.documentElement.appendChild(host);
    }).observe(document.documentElement, { childList: true });
  }

  function $(sel) {
    mount();
    return root && root.querySelector(sel);
  }

  function place() {
    const c = root && root.querySelector('.cursor');
    if (c) c.style.transform = `translate(${state.x - 4}px, ${state.y - 2}px)`;
  }

  addEventListener(
    'mousemove',
    (e) => {
      state.x = e.clientX;
      state.y = e.clientY;
      place();
    },
    true,
  );
  addEventListener(
    'mousedown',
    (e) => {
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      $('.layer')?.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    true,
  );

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = '__wt_card:';

  // window.name survives same-site navigations in a tab, which is all a recording does.
  function readCarried() {
    try {
      return window.name.startsWith(KEY) ? JSON.parse(window.name.slice(KEY.length)) : null;
    } catch {
      return null;
    }
  }

  function showCard({ eyebrow = '', title = '', sub = '' }, fade = true) {
    const card = root.querySelector('.card');
    card.querySelector('.eyebrow').textContent = eyebrow;
    card.querySelector('.title').textContent = title;
    card.querySelector('.sub').textContent = sub;
    if (!fade) {
      card.style.transition = 'none';
      card.classList.add('on');
      void card.offsetWidth;
      card.style.transition = '';
    } else card.classList.add('on');
    window.name = KEY + JSON.stringify({ eyebrow, title, sub });
    return card;
  }

  window.__wt = {
    setCursor(x, y) {
      state.x = x;
      state.y = y;
      mount();
      place();
    },
    async chapter(c, holdMs = 2600) {
      if (!$('.card')) return;
      const card = showCard(c);
      if (holdMs > 0) {
        await wait(holdMs);
        await window.__wt.hideChapter();
      } else await wait(650);
    },
    async hideChapter() {
      if (window.name.startsWith(KEY)) window.name = '';
      const card = $('.card');
      if (!card || !card.classList.contains('on')) return;
      card.classList.remove('on');
      await wait(650);
    },
    highlight(rect, tag) {
      const ring = $('.ring');
      if (!ring) return;
      if (!rect) {
        ring.classList.remove('on');
        return;
      }
      const pad = 8;
      Object.assign(ring.style, { left: `${rect.x - pad}px`, top: `${rect.y - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
      const t = ring.querySelector('.tag');
      t.hidden = !tag;
      t.textContent = tag || '';
      ring.classList.add('on');
    },
    cursorVisible(on) {
      const c = $('.cursor');
      if (c) c.style.visibility = on ? '' : 'hidden';
    },
    label(text) {
      const l = $('.label');
      if (!l) return;
      l.textContent = text || '';
      l.classList.toggle('on', !!text);
    },
  };

  // Mount straight away (before the page paints) so a carried card never flickers.
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
