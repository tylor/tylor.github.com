const MANIFEST = "polaroids/manifest.json";
const BASE = "polaroids/";
const PILE_DEPTH = 14; // cards buried deeper than this fade out and are skipped
const TIDY_DEPTH = 24; // how many cards the squared-up stack at the end shows
const ZOOM_MS = 460;
const MAX_MAG = 3.5; // how far past full-screen a pinch can go
// Which cutouts the pile uses: "web" (1200px, light on memory; zooming swaps
// in the full one) or "full" (1740px from the start). If phones struggle
// with "full", switch back to "web".
const PILE_IMAGES = "web";
// The picture area of a 600/i-Type frame, as fractions of the frame.
const PHOTO_SIDE = 0.894; // of the width
const PHOTO_TOP = 0.058; // of the height
const LOAD_CONCURRENCY = 6;
const START_AFTER = 3; // photos loaded before you can start scrolling
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Table: topographic contours + grain                                 */
/* ------------------------------------------------------------------ */

function makeNoise(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => ((h & 1) ? x : -x) + ((h & 2) ? y : -y);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    return lerp(
      lerp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u),
      lerp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u),
      v,
    );
  };
}

// Marching-squares segments per case, as pairs of edges (0 top, 1 right, 2 bottom, 3 left).
const SEGMENTS = [[], [3, 2], [2, 1], [3, 1], [0, 1], [3, 0, 2, 1], [0, 2], [3, 0],
  [3, 0], [0, 2], [0, 1, 3, 2], [0, 1], [3, 1], [2, 1], [3, 2], []];

function drawContours(canvas) {
  const size = Math.ceil(Math.max(screen.width, screen.height, innerWidth, innerHeight) * 1.05);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.height = Math.round(size * dpr);
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.dataset.size = size;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const noise = makeNoise(1783);
  const fbm = (x, y) => {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 3; o++) { v += amp * noise(x * f, y * f); amp *= 0.5; f *= 2.03; }
    return v;
  };

  const cell = 4;
  const n = Math.ceil(size / cell) + 1;
  const field = new Float32Array(n * n);
  const scale = 1 / 900;
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * cell * scale, y = j * cell * scale;
      // domain warp gives the lava-flow / glacier-valley feel
      const wx = fbm(x + 3.1, y + 7.7), wy = fbm(x - 4.2, y + 1.3);
      const v = fbm(x + 1.6 * wx, y + 1.6 * wy);
      field[j * n + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const levels = 16;
  const step = (max - min) / levels;
  const minor = new Path2D(), major = new Path2D();
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = field[j * n + i], b = field[j * n + i + 1];
      const c = field[(j + 1) * n + i + 1], d = field[(j + 1) * n + i];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      const x0 = i * cell, y0 = j * cell, x1 = x0 + cell, y1 = y0 + cell;
      for (let k = Math.ceil((lo - min) / step); min + k * step <= hi; k++) {
        const L = min + k * step;
        const code = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
        const segs = SEGMENTS[code];
        if (!segs.length) continue;
        const pt = (e) => {
          switch (e) {
            case 0: return [lerp(x0, x1, (L - a) / (b - a)), y0];
            case 1: return [x1, lerp(y0, y1, (L - b) / (c - b))];
            case 2: return [lerp(x0, x1, (L - d) / (c - d)), y1];
            default: return [x0, lerp(y0, y1, (L - a) / (d - a))];
          }
        };
        const path = k % 5 === 0 ? major : minor;
        for (let s = 0; s < segs.length; s += 2) {
          const [ax, ay] = pt(segs[s]), [bx, by] = pt(segs[s + 1]);
          path.moveTo(ax, ay);
          path.lineTo(bx, by);
        }
      }
    }
  }
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(239, 232, 214, 0.07)";
  ctx.lineWidth = 1;
  ctx.stroke(minor);
  ctx.strokeStyle = "rgba(239, 232, 214, 0.13)";
  ctx.lineWidth = 1.4;
  ctx.stroke(major);
}

function makeGrain() {
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(160, 160);
  const rand = mulberry32(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rand() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = rand() * 22;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function shadowSprite(blur, alpha) {
  // Pre-blurred shadow bitmaps: moving these is free on the compositor,
  // unlike animating box-shadow or filter: blur().
  const w = 248, h = Math.round(w / 0.821);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const inset = 1 - 1 / 1.24; // .shadow extends 12% beyond the card on each side
  ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
  ctx.shadowBlur = blur * w;
  ctx.shadowOffsetX = 10000;
  ctx.fillRect(w * inset / 2 - 10000, h * inset / 2, w * (1 - inset), h * (1 - inset));
  return c.toDataURL();
}


/* ------------------------------------------------------------------ */
/* Caption                                                             */
/* ------------------------------------------------------------------ */

function formatDate(d) {
  if (!d) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : d; // "Sept 5, 2026"
}

// One line of caption text. New text rolls in over the old, like a page
// turning; the direction follows the scroll direction.
class Line {
  constructor(el) {
    this.el = el;
    this.text = null;
    this.span = null;
  }

  set(text, dir, delay) {
    if (text === this.text) return;
    this.text = text;
    this.el.classList.toggle("is-blank", !text);
    const old = this.span;
    const span = document.createElement("span");
    span.textContent = text;
    this.el.appendChild(span);
    this.span = span;
    const off = (s) => `translateY(${s * 60}%) rotateX(${s * -75}deg)`;
    const ease = "cubic-bezier(.2, .75, .25, 1)";
    span.animate([{ transform: off(dir), opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 560, delay: delay + 60, easing: ease, fill: "backwards" });
    if (old) {
      old.animate([{ opacity: 1 }, { transform: off(-dir), opacity: 0 }],
        { duration: 380, delay, easing: ease, fill: "forwards" })
        .finished.then(() => old.remove(), () => old.remove());
    }
  }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

function loadOnce(src, timeout) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.draggable = false;
    img.alt = "";
    const timer = setTimeout(() => { img.src = ""; reject(new Error("timeout")); }, timeout);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("error")); };
    img.src = src;
  });
}

async function loadImage(src) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const img = await loadOnce(attempt ? `${src}?retry=${attempt}` : src, 15000 + attempt * 10000);
      // Pre-decode so nothing stalls mid-scroll. Browsers may refuse or never
      // settle (e.g. in a background tab); then it decodes on first paint.
      await Promise.race([img.decode().catch(() => {}), sleep(2000)]);
      return img;
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  return null;
}

// Loads images in manifest order, a few at a time, reporting each one
// (or null if it failed after retries) as soon as it's done.
function loadAll(srcs, onLoad) {
  let next = 0;
  const worker = async () => {
    while (next < srcs.length) {
      const i = next++;
      onLoad(i, await loadImage(srcs[i]));
    }
  };
  return Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const all = await (await fetch(MANIFEST, { cache: "no-cache" })).json();
  const total = all.length;
  const firstBatch = Math.min(START_AFTER, total);
  const status = $("status");
  status.textContent = `Loading 0 of ${firstBatch}`;

  // Let the title paint before the (synchronous) contour drawing. Background
  // tabs get no animation frames, so don't wait on them forever.
  await Promise.race([nextFrame().then(nextFrame), sleep(100)]);
  $("grain").style.backgroundImage = `url(${makeGrain()})`;
  const contours = $("contours");
  drawContours(contours);

  const soft = shadowSprite(0.09, 0.55);
  const contact = shadowSprite(0.018, 0.55);
  const stage = $("stage");
  const pile = $("pile");
  const probe = document.createElement("div");
  probe.className = "card";
  probe.style.cssText = "display:block;visibility:hidden";
  pile.appendChild(probe);

  const scroller = $("scroller");
  const track = $("track");
  track.innerHTML = "<section></section>"; // the title screen; one more per card
  const pad2 = (n) => String(n).padStart(2, "0");

  const cards = [];
  const addCard = (m, img) => {
    const r = mulberry32(cards.length * 7919 + 13);
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `<div class="shadow"></div><div class="shadow"></div>`;
    const [softEl, contactEl] = el.children;
    softEl.style.backgroundImage = `url(${soft})`;
    contactEl.style.backgroundImage = `url(${contact})`;
    el.appendChild(img);
    pile.appendChild(el);
    track.appendChild(document.createElement("section"));
    let rot = (r() - 0.5) * 17;
    if (Math.abs(rot) < 1.2) rot += rot < 0 ? -1.5 : 1.5;
    const sweep = (r() < 0.5 ? -1 : 1) * (9 + r() * 12);
    cards.push({
      m, el, img, web: img, softEl, contactEl,
      px: (r() - 0.5) * 0.12, py: (r() - 0.5) * 0.08, rot, // resting place on the pile
      fx: (r() - 0.5) * 0.5, frot: rot + sweep, tilt: 9 + r() * 7, // where it's held coming in
      trot: (r() - 0.5) * 1.8, // barely-askew angle once the pile is squared up
      t: -1, tidy: -1, zoom: -1, opacity: 1, visible: false, full: false,
    });
  };

  // Photos join the pile strictly in order, so you can never scroll onto one
  // that isn't ready. Viewing starts once the first few are in; the rest keep
  // loading behind. Anything that fails after retries is skipped.
  const results = new Array(total);
  let placed = 0;
  let allPlaced = false;
  let frame = 0;
  let schedule = () => {};
  let ready, started = false;
  const readyToStart = new Promise((resolve) => { ready = resolve; });
  loadAll(all.map((m) => BASE + m[PILE_IMAGES]), (i, img) => {
    results[i] = img;
    while (placed < total && results[placed] !== undefined) {
      if (results[placed]) addCard(all[placed], results[placed]);
      placed++;
    }
    if (placed === total && !allPlaced && cards.length) {
      // One last scroll step, for squaring up the pile.
      allPlaced = true;
      track.appendChild(document.createElement("section"));
      schedule();
    }
    if (started) return;
    status.textContent = `Loading ${Math.min(cards.length, firstBatch)} of ${firstBatch}`;
    if (cards.length >= firstBatch || placed === total) {
      started = true;
      ready();
    }
  });
  await readyToStart;
  if (!cards.length) {
    status.textContent = "Couldn't load the photos. Reload to try again.";
    return;
  }

  const intro = $("intro");
  const caption = $("caption");
  const lines = ["place", "date", "count"].map((id) => new Line($(id)));
  const save = $("save");

  let step = 1, cw = 1, ch = 1, stageH = 1, anchorY = 0;
  let shown = null, introOpacity = -1;

  // Click, tap or pinch to look at the top card up close. view.zoom goes from
  // 0 (on the pile) to 1 (straightened, picture filling the screen); past that
  // a pinch magnifies further (view.mag) and view.x/y pan the picture.
  const dim = document.createElement("div");
  dim.className = "dim";
  pile.appendChild(dim);
  const zoomScale = () => Math.min(innerWidth * 0.96, stageH * 0.9) / (PHOTO_SIDE * cw);
  const view = { zoom: 0, mag: 1, x: 0, y: 0 };
  let zoomed = -1, viewKey = 0, goal = 0, tween = 0, settling = null;

  // Touch screens: the pile is moved by our own drag-and-spring code rather
  // than Safari's scrolling, because Safari swallows any tap that lands while
  // its scroll is still gliding (and it glides long after it looks settled).
  // Desktop keeps native scrolling, where clicks aren't affected.
  // (?touch forces it, for testing on a desktop.)
  const virtual = location.search.includes("touch") || !matchMedia("(hover: hover) and (pointer: fine)").matches;
  let vpos = 0; // scroll position in px, when virtual
  const pos = () => (virtual ? vpos : scroller.scrollTop);
  const setPos = (px) => {
    if (!virtual) return void (scroller.scrollTop = px);
    vpos = px;
    schedule();
  };
  if (virtual) scroller.classList.add("is-virtual");

  // Only re-render the cards when a size actually changed.
  const measure = () => {
    const r = probe.getBoundingClientRect();
    const next = [track.children[0].getBoundingClientRect().height, probe.offsetWidth, probe.offsetHeight, stage.offsetHeight, r.top + r.height / 2];
    if (next.join() === [step, cw, ch, stageH, anchorY].join()) return false;
    const oldStep = step;
    [step, cw, ch, stageH, anchorY] = next;
    vpos *= step / oldStep; // stay on the same photo
    if (Math.max(innerWidth, innerHeight) > +contours.dataset.size) drawContours(contours);
    cards.forEach((c) => { c.t = -1; c.tidy = -1; c.zoom = -1; });
    return true;
  };

  const render = () => {
    frame = 0;
    const p = pos() / step;
    const n = cards.length;
    const end = allPlaced ? clamp01(p - n) : 0; // squaring up the pile

    for (let i = 0; i < n; i++) {
      const c = cards[i];
      const t = clamp01(p - i);
      const depth = Math.min(p, n) - 1 - i; // how many cards now lie on top of this one
      // Lower cards straighten first, the top one last.
      const tidy = depth < TIDY_DEPTH
        ? easeInOutCubic(clamp01(end * 1.6 - (1 - depth / TIDY_DEPTH) * 0.6)) : 0;
      const opacity = Math.max(clamp01((PILE_DEPTH - depth) / 2), tidy);
      const visible = t > 0 && opacity > 0;
      if (visible !== c.visible) {
        c.el.style.display = visible ? "block" : "none";
        c.visible = visible;
      }
      if (!visible) continue;
      if (opacity !== c.opacity) {
        c.el.style.opacity = opacity.toFixed(3);
        c.opacity = opacity;
      }
      const zk = i === zoomed ? viewKey : -1;
      if (t === c.t && tidy === c.tidy && zk === c.zoom) continue;
      c.t = t;
      c.tidy = tidy;
      c.zoom = zk;
      const zm = i === zoomed ? view.zoom : 0;

      const move = easeOutCubic(clamp01(t / 0.85));
      const land = clamp01((t - 0.35) / 0.65);
      const lift = Math.max(1 - land * land, zm); // held above the pile, then drops in
      const startY = stageH * 0.56 + ch * 0.8 + 40;
      // Squared up, each card sits a hair down-right of the one above, so the
      // stack shows its thickness.
      let x = lerp(lerp(c.fx * cw, c.px * cw, move), depth * 0.0017 * cw, tidy);
      let y = lerp(lerp(startY, c.py * ch, move), depth * 0.0024 * ch, tidy);
      let rot = lerp(lerp(c.frot, c.rot, move), c.trot, tidy);
      const tilt = c.tilt * (1 - move);
      let scale = 1 + 0.075 * (1 - land * land);
      if (zm > 0) {
        // Up close: straight, and scaled so the picture (not the frame) fills
        // the screen, centred (plus any pinch magnification and pan).
        const side = PHOTO_SIDE * cw;
        const photoY = PHOTO_TOP * ch + side / 2 - ch / 2; // picture centre, from card centre
        const S = zoomScale() * view.mag;
        x = lerp(x, view.x, zm);
        y = lerp(y, stageH / 2 - anchorY - photoY * S + view.y, zm);
        rot = lerp(rot, 0, zm);
        scale = lerp(scale, S, zm);
      }
      c.el.style.transform =
        `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${rot.toFixed(3)}deg) rotateX(${tilt.toFixed(3)}deg) scale(${scale.toFixed(4)})`;
      c.softEl.style.opacity = lift.toFixed(3);
      c.softEl.style.transform = `translate3d(0, ${(ch * (0.02 + 0.08 * lift)).toFixed(2)}px, 0) scale(${1 + 0.05 * lift})`;
      c.contactEl.style.opacity = (1 - lift).toFixed(3);
    }

    // Title sits on the table until the first card covers it
    const io = +(1 - clamp01(p / 0.5)).toFixed(3);
    if (io !== introOpacity) {
      intro.style.opacity = io;
      introOpacity = io;
    }

    // Caption follows whatever is on top of the pile; past the last card
    // (index n) the squared-up stack stands on its own.
    const idx = p < 0.5 ? -1 : Math.min(allPlaced ? n : n - 1, Math.round(p) - 1);
    if (idx !== shown) {
      const dir = idx > (shown ?? -1) ? 1 : -1;
      shown = idx;
      const m = cards[idx]?.m;
      const text = idx < 0 || idx === n ? ["", "", ""] : [m.place || m.id.replace("_", " "), formatDate(m.date), `${pad2(idx + 1)} of ${total}`];
      lines.forEach((l, k) => l.set(text[k], dir, k * 45));
      caption.classList.toggle("is-empty", idx < 0 || idx === n);
      if (m) save.href = BASE + m.download;
    }
  };

  const hasMouse = !virtual;

  // While a photo is picked up the pile can't scroll; scroll gestures put it
  // back down instead. Stays locked until trackpad momentum dies away, so a
  // flick can't carry on into the next photo.
  let lastWheel = 0, unlockTimer = 0;
  const updateLock = () => {
    const quiet = performance.now() - lastWheel > 250;
    scroller.classList.toggle("is-locked", zoomed >= 0 || !quiet);
    caption.classList.toggle("is-hidden", zoomed >= 0);
    if (hasMouse) scroller.style.cursor = zoomed < 0 ? "" : view.mag > 1.01 ? "grab" : "zoom-out";
  };

  const setView = (v) => {
    Object.assign(view, v);
    viewKey++;
    dim.style.opacity = (view.zoom * 0.6).toFixed(3);
    render();
  };

  const release = () => {
    const c = cards[zoomed];
    c.el.style.zIndex = "";
    c.el.style.willChange = "";
    dropFull(c);
    zoomed = -1;
    updateLock();
  };

  const animateView = (target) => {
    cancelAnimationFrame(tween);
    goal = target.zoom;
    if (zoomed >= 0) cards[zoomed].el.style.willChange = "";
    const from = { ...view };
    const t0 = performance.now();
    const scrollFix = settling;
    settling = null;
    const tick = (now) => {
      const k = clamp01((now - t0) / ZOOM_MS);
      const e = easeInOutCubic(k);
      if (scrollFix) setPos(lerp(scrollFix.from, scrollFix.to, easeOutCubic(k)));
      setView(Object.fromEntries(Object.keys(target).map((key) => [key, lerp(from[key], target[key], e)])));
      if (k < 1) {
        tween = requestAnimationFrame(tick);
      } else if (view.zoom === 0) {
        release();
      } else {
        // Chrome keeps will-change layers at their original resolution,
        // so drop it once up close to get a sharp re-render.
        cards[zoomed].el.style.willChange = "auto";
        updateLock();
      }
    };
    tween = requestAnimationFrame(tick);
  };
  const zoomIn = () => animateView({ zoom: 1, mag: 1, x: 0, y: 0 });
  const zoomOut = () => { if (zoomed >= 0) animateView({ zoom: 0, mag: 1, x: 0, y: 0 }); };
  const isOpen = () => zoomed >= 0 && goal > 0;

  // Keep the magnified picture covering the screen.
  const clampPan = (x, y, mag) => {
    const half = (PHOTO_SIDE * cw * zoomScale() * mag) / 2;
    const mx = Math.max(0, half - innerWidth / 2), my = Math.max(0, half - stageH / 2);
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  };

  // Scale relative to the card's size on the pile.
  const currentScale = () => (view.zoom < 1 ? lerp(1, zoomScale(), view.zoom) : zoomScale() * view.mag);
  // Where a screen point falls on the picture, as a fraction of its size from
  // its centre (as if already up close, when starting from the pile).
  const pictureAt = (sx, sy) => {
    const size = PHOTO_SIDE * cw * zoomScale() * (view.zoom < 1 ? 1 : view.mag);
    const ox = view.zoom < 1 ? 0 : view.x, oy = view.zoom < 1 ? 0 : view.y;
    return { u: (sx - innerWidth / 2 - ox) / size, v: (sy - stageH / 2 - oy) / size };
  };
  // Scale to s, keeping picture point `at` under the screen point (sx, sy).
  const scaleTo = (s, sx, sy, at) => {
    const Z = zoomScale();
    if (s <= Z) return setView({ zoom: Math.max(0, (s - 1) / (Z - 1)), mag: 1, x: 0, y: 0 });
    const mag = Math.min(s / Z, MAX_MAG * 1.15);
    const size = PHOTO_SIDE * cw * Z * mag;
    setView({ zoom: 1, mag, ...clampPan(sx - innerWidth / 2 - at.u * size, sy - stageH / 2 - at.v * size, mag) });
  };
  // After a pinch: stay magnified, or settle up close / back on the pile.
  const settle = (opening) => {
    if (view.mag > 1.01) {
      const mag = Math.min(view.mag, MAX_MAG);
      animateView({ zoom: 1, mag, ...clampPan(view.x, view.y, mag) });
    } else if (opening ? view.zoom > 0.25 : view.zoom > 0.75) {
      zoomIn();
    } else {
      zoomOut();
    }
  };

  // The card someone means when they tap or pinch: the newest one that's at
  // least a third of the way in, so a card still arriving counts. (On iPhone
  // a tap during a scroll first stops it, often between photos.) With a
  // point, it has to be under it. Not at the end, once the pile's squared up.
  const cardAt = (x, y) => {
    const p = pos() / step;
    if (p > cards.length + 0.3) return -1;
    const newest = Math.min(cards.length - 1, Math.floor(p));
    for (let i = newest; i >= 0 && i >= newest - 1; i--) {
      if (p - i < 0.35) continue;
      if (x === undefined) return i;
      const r = cards[i].el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return -1;
  };

  // Full resolution only while up close; phones run out of memory fast.
  const loadFull = async (c) => {
    if (c.full || PILE_IMAGES === "full") return;
    c.full = true;
    const img = await loadImage(BASE + c.m.full);
    if (!img || !c.full) return;
    c.el.replaceChild(img, c.img);
    c.img = img;
  };
  const dropFull = (c) => {
    c.full = false;
    if (c.img === c.web) return;
    c.el.replaceChild(c.web, c.img);
    c.img = c.web;
  };

  const pickUp = (i) => {
    cancelAnimationFrame(tween);
    // If the pile's still moving, ease it the rest of the way to this card
    // alongside the zoom (see animateView) so it's settled underneath.
    const rest = (i + 1) * step;
    cancelAnimationFrame(glideFrame);
    settling = Math.abs(pos() - rest) > 0.5 ? { from: pos(), to: rest } : null;
    zoomed = i;
    cards[i].el.style.zIndex = 2;
    cards[i].el.style.willChange = "";
    loadFull(cards[i]);
    updateLock();
  };

  // ?debug on the URL shows what each tap saw, for chasing phone-only issues.
  const debugEl = location.search.includes("debug") && document.body.appendChild(document.createElement("pre"));
  if (debugEl) debugEl.style.cssText = "position:fixed;top:0;left:0;z-index:9;margin:0;padding:6px 8px;font:11px/1.3 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.7);pointer-events:none;max-width:100vw;white-space:pre-wrap";
  const debug = (msg) => {
    if (!debugEl) return;
    const lines = (debugEl.textContent ? debugEl.textContent.split("\n") : []).slice(-7);
    lines.push(`${(performance.now() / 1000).toFixed(2)} ${msg}`);
    debugEl.textContent = lines.join("\n");
  };

  const tapAt = (x, y) => {
    const p = pos() / step;
    debug(`tap ${Math.round(x)},${Math.round(y)} p=${p.toFixed(3)} open=${isOpen()} zoomed=${zoomed} card=${cardAt(x, y)}`);
    if (isOpen()) return zoomOut();
    const i = zoomed >= 0 ? zoomed : cardAt(x, y);
    if (i < 0) return;
    pickUp(i);
    zoomIn();
  };

  /* ---- mouse and keyboard ---- */

  let drag = null, dragged = false;
  scroller.addEventListener("click", (e) => {
    if (dragged) { dragged = false; return; }
    tapAt(e.clientX, e.clientY);
  });
  if (hasMouse) {
    // Mouse only: on iOS a tap sends a fake mousemove first, and changing
    // anything in response makes Safari treat the tap as a hover and drop it.
    scroller.addEventListener("mousemove", (e) => {
      if (zoomed < 0) scroller.style.cursor = cardAt(e.clientX, e.clientY) >= 0 ? "zoom-in" : "";
    });
    scroller.addEventListener("mousedown", (e) => {
      if (isOpen() && view.mag > 1.01) drag = { x: e.clientX, y: e.clientY, px: view.x, py: view.y };
    });
    addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) dragged = true;
      setView(clampPan(drag.px + dx, drag.py + dy, view.mag));
    });
    addEventListener("mouseup", () => { drag = null; });
  }

  let wheelSettle = 0;
  scroller.addEventListener("wheel", (e) => {
    if (e.ctrlKey) {
      // Trackpad pinch (and ctrl + scroll wheel).
      if (zoomed < 0) {
        const i = cardAt(e.clientX, e.clientY);
        if (i < 0) return;
        pickUp(i);
      }
      e.preventDefault();
      cancelAnimationFrame(tween);
      const s0 = currentScale();
      const s = s0 * Math.exp(-e.deltaY * 0.01);
      scaleTo(s, e.clientX, e.clientY, pictureAt(e.clientX, e.clientY));
      clearTimeout(wheelSettle);
      wheelSettle = setTimeout(() => settle(true), 180);
      return;
    }
    if (!scroller.classList.contains("is-locked")) return;
    e.preventDefault();
    lastWheel = performance.now();
    if (isOpen() && view.mag > 1.01) {
      setView(clampPan(view.x - e.deltaX, view.y - e.deltaY, view.mag)); // scroll pans
    } else {
      zoomOut();
    }
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(updateLock, 260);
  }, { passive: false });

  addEventListener("keydown", (e) => {
    if (zoomed < 0) return;
    if (["Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      zoomOut();
    }
  });

  /* ---- touch ---- */

  // Spring the pile to a photo after a drag. v is the finger's speed in px/ms
  // (positive = onwards). Faster flicks can carry past more than one photo.
  const maxPos = () => (track.children.length - 1) * step;
  let glideFrame = 0;
  const glide = (v) => {
    cancelAnimationFrame(glideFrame);
    const cur = pos() / step;
    let target = Math.round(cur + Math.max(-4, Math.min(4, (v * 300) / step)));
    if (Math.abs(v) > 0.2) {
      target = v > 0 ? Math.max(target, Math.floor(cur) + 1) : Math.min(target, Math.ceil(cur) - 1);
    }
    const to = Math.min(track.children.length - 1, Math.max(0, target)) * step;
    let x = pos(), vel = v * 1000, last = performance.now();
    const w = 14; // stiffness; critically damped, so no wobble
    const tick = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      vel += (-w * w * (x - to) - 2 * w * vel) * dt;
      x += vel * dt;
      if (Math.abs(x - to) < 0.5 && Math.abs(vel) < 30) return setPos(to);
      setPos(x);
      glideFrame = requestAnimationFrame(tick);
    };
    glideFrame = requestAnimationFrame(tick);
  };

  // Taps are handled here rather than via click, which iOS sometimes eats.
  // Two fingers pinch; one finger pans when magnified, or puts the photo
  // back down when it's just up close.
  let touch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const middle = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  scroller.addEventListener("touchstart", (e) => {
    cancelAnimationFrame(glideFrame); // a touch catches the pile mid-glide
    if (e.touches.length === 2) {
      if (zoomed < 0) {
        const i = cardAt();
        if (i < 0) return;
        pickUp(i);
      }
      e.preventDefault();
      cancelAnimationFrame(tween);
      const mid = middle(e.touches);
      touch = { mode: "pinch", d0: spread(e.touches), s0: currentScale(), at: pictureAt(mid.x, mid.y) };
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      touch = { mode: "tap", x: t.clientX, y: t.clientY, t0: performance.now(), px: view.x, py: view.y };
    }
  }, { passive: false });
  scroller.addEventListener("touchmove", (e) => {
    if (!touch) return;
    if (touch.mode === "pinch") {
      if (e.touches.length !== 2) return;
      const mid = middle(e.touches);
      scaleTo(touch.s0 * (spread(e.touches) / touch.d0), mid.x, mid.y, touch.at);
      return;
    }
    const t = e.touches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (touch.mode === "tap" && Math.hypot(dx, dy) > 10) {
      touch.mode = !isOpen() ? "scroll" : view.mag > 1.01 ? "pan" : "dismiss";
      if (touch.mode === "dismiss") zoomOut();
      touch.sy = t.clientY; // drag from here, so the pile doesn't jump
      touch.spos = pos();
      touch.samples = [];
    }
    if (touch.mode === "pan") setView(clampPan(touch.px + dx, touch.py + dy, view.mag));
    if (touch.mode === "scroll" && virtual) {
      // The pile follows the finger, with resistance past either end.
      const max = maxPos();
      let np = touch.spos + (touch.sy - t.clientY);
      if (np < 0) np *= 0.35;
      else if (np > max) np = max + (np - max) * 0.35;
      setPos(np);
      const now = performance.now();
      touch.samples.push({ y: t.clientY, t: now });
      while (touch.samples.length > 2 && now - touch.samples[0].t > 100) touch.samples.shift();
    }
    // Passive, so native scrolling (desktop) never waits on this; on touch
    // screens the scroller is .is-virtual, so there's nothing to block.
  }, { passive: true });
  const touchEnd = (e) => {
    if (!touch) return;
    if (touch.mode === "pinch") {
      if (e.touches.length < 2) {
        settle(currentScale() >= touch.s0);
        touch = null;
      }
      return;
    }
    debug(`${e.type} mode=${touch.mode} ${Math.round(performance.now() - touch.t0)}ms touches=${e.touches.length}`);
    if (touch.mode === "tap" && e.type === "touchend" && performance.now() - touch.t0 < 400) {
      e.preventDefault(); // no follow-up click
      tapAt(touch.x, touch.y);
    }
    if (virtual && !e.touches.length && zoomed < 0) {
      // Let go: spring to a photo, carrying the flick's speed. (Also resumes
      // a glide that a tap off the photos interrupted.)
      const sm = touch.mode === "scroll" ? touch.samples : [];
      const a = sm[0], b = sm[sm.length - 1];
      // Speed over the last ~100ms, at least a frame's worth, and capped, so a
      // jittery sample can't fling the pile.
      const v = a && b !== a ? (a.y - b.y) / Math.max(16, b.t - a.t) : 0;
      glide(Math.max(-4, Math.min(4, v)));
    }
    if (!e.touches.length) touch = null;
  };
  scroller.addEventListener("touchend", touchEnd, { passive: false });
  scroller.addEventListener("touchcancel", touchEnd);

  // Safari's own pinch-zoom (page zoom on iPhone, gesture events on Mac
  // trackpads) fights all of the above. On a Mac, use it to drive ours.
  let gesture = null;
  document.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    if (!hasMouse) return;
    if (zoomed < 0) {
      const i = cardAt(e.clientX, e.clientY);
      if (i < 0) return;
      pickUp(i);
    }
    cancelAnimationFrame(tween);
    gesture = { s0: currentScale(), at: pictureAt(e.clientX, e.clientY) };
  }, { passive: false });
  document.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (gesture) scaleTo(gesture.s0 * e.scale, e.clientX, e.clientY, gesture.at);
  }, { passive: false });
  document.addEventListener("gestureend", (e) => {
    e.preventDefault();
    if (!gesture) return;
    settle(e.scale >= 1);
    gesture = null;
  }, { passive: false });

  schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  scroller.addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", () => { if (measure()) schedule(); });

  measure();
  status.textContent = "Scroll to begin";
  document.body.classList.remove("is-loading");
  scroller.focus({ preventScroll: true }); // so arrow keys / space work on desktop
  render();
}

main();
