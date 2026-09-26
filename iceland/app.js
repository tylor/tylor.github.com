const MANIFEST = "polaroids/manifest.json";
const BASE = "polaroids/";
const PILE_DEPTH = 14; // cards buried deeper than this fade out and are skipped
const TIDY_DEPTH = 24; // how many cards the squared-up stack at the end shows
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
      m, el, softEl, contactEl,
      px: (r() - 0.5) * 0.12, py: (r() - 0.5) * 0.08, rot, // resting place on the pile
      fx: (r() - 0.5) * 0.5, frot: rot + sweep, tilt: 9 + r() * 7, // where it's held coming in
      trot: (r() - 0.5) * 1.8, // barely-askew angle once the pile is squared up
      t: -1, tidy: -1, opacity: 1, visible: false,
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
  loadAll(all.map((m) => BASE + m.web), (i, img) => {
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

  let step = 1, cw = 1, ch = 1, stageH = 1;
  let shown = null, introOpacity = -1;

  // Only re-render the cards when a size actually changed.
  const measure = () => {
    const next = [track.children[1].offsetTop, probe.offsetWidth, probe.offsetHeight, stage.offsetHeight];
    if (next.join() === [step, cw, ch, stageH].join()) return false;
    [step, cw, ch, stageH] = next;
    if (Math.max(innerWidth, innerHeight) > +contours.dataset.size) drawContours(contours);
    cards.forEach((c) => { c.t = -1; c.tidy = -1; });
    return true;
  };

  const render = () => {
    frame = 0;
    const p = scroller.scrollTop / step;
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
      if (t === c.t && tidy === c.tidy) continue;
      c.t = t;
      c.tidy = tidy;

      const move = easeOutCubic(clamp01(t / 0.85));
      const land = clamp01((t - 0.35) / 0.65);
      const lift = 1 - land * land; // held above the pile, then drops in
      const startY = stageH * 0.56 + ch * 0.8 + 40;
      // Squared up, each card sits a hair down-right of the one above, so the
      // stack shows its thickness.
      const x = lerp(lerp(c.fx * cw, c.px * cw, move), depth * 0.0017 * cw, tidy);
      const y = lerp(lerp(startY, c.py * ch, move), depth * 0.0024 * ch, tidy);
      const rot = lerp(lerp(c.frot, c.rot, move), c.trot, tidy);
      const tilt = c.tilt * (1 - move);
      const scale = 1 + 0.075 * lift;
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
