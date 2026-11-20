'use strict';

// Canvas hourglass. Sand levels follow `progress` (0 = top full, 1 = bottom full),
// a thin stream of grains falls while `flowing`. Drawn in a 120 x 180 unit space.
(() => {
  const W = 120, H = 180, CX = 60;
  const Y0 = 19, YN = 90, Y1 = 161;       // glass top, neck, bottom
  const MAXW = 37, NECK = 2.3;            // half-widths
  const FILL = 0.6;                       // share of a bulb the sand fills

  const halfWidth = (y) => {
    const d = Math.min(1, Math.abs(y - YN) / (YN - Y0));
    const body = NECK + (MAXW - NECK) * (1 - Math.pow(1 - d, 2.3));
    return body * (1 - 0.1 * Math.max(0, (d - 0.9) / 0.1)); // tuck in under the caps
  };

  // Cumulative glass area measured from the neck outwards (the same for both bulbs).
  const STEP = 0.25;
  const area = [0];
  for (let y = YN; y > Y0; y -= STEP) area.push(area[area.length - 1] + 2 * halfWidth(y) * STEP);
  const BULB = area[area.length - 1];
  const SAND = BULB * FILL;
  // Distance from the neck at which `amount` of area is filled.
  const depthFor = (amount) => {
    let lo = 0, hi = area.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] < amount) lo = mid + 1; else hi = mid; }
    return lo * STEP;
  };

  function grainPattern(ctx) {
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const g = c.getContext('2d');
    for (let i = 0; i < 260; i++) {
      const light = Math.random() < 0.55;
      g.fillStyle = light ? `rgba(255,240,205,${0.25 + Math.random() * 0.35})` : `rgba(120,60,10,${0.2 + Math.random() * 0.3})`;
      g.fillRect(Math.random() * 48, Math.random() * 48, 1, 1);
    }
    return ctx.createPattern(c, 'repeat');
  }

  class Hourglass {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.pattern = grainPattern(this.ctx);
      this.progress = 0;       // shown
      this.target = 0;         // wanted
      this.flowing = false;
      this.reveal = 1;         // 0..1, used to draw the glass in on startup
      this.grains = [];
      this.sparkles = Array.from({ length: 7 }, () => ({ x: Math.random(), phase: Math.random() * 6.28 }));
      this.raf = 0;
      this.last = 0;
      this.flipping = false;
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
      document.addEventListener('visibilitychange', () => this.wake());
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      this.draw();
    }

    setProgress(p, instant = false) {
      this.target = Math.min(1, Math.max(0, p));
      if (instant) this.progress = this.target;
      this.wake();
    }

    setFlowing(on) {
      if (this.flowing === on) return;
      this.flowing = on;
      this.wake();
    }

    /** Turn the glass over: the full bottom becomes the top. Resolves when done. */
    async flip(host, duration = 1100) {
      if (this.flipping) return;
      this.flipping = true;
      const wasFlowing = this.flowing;
      this.flowing = false;
      this.grains = [];
      this.setProgress(1, true);
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduce) {
        await host.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }],
          { duration, easing: 'cubic-bezier(.7,0,.25,1)' },
        ).finished.catch(() => {});
      }
      this.setProgress(0, true); // looks identical to the turned glass
      this.flowing = wasFlowing;
      this.flipping = false;
      this.wake();
    }

    /** Draw the glass in, for the startup animation. */
    animateReveal(duration) {
      return new Promise((resolve) => {
        const start = performance.now();
        const tick = (now) => {
          this.reveal = Math.min(1, (now - start) / duration);
          this.draw();
          if (this.reveal < 1) requestAnimationFrame(tick); else resolve();
        };
        this.reveal = 0;
        requestAnimationFrame(tick);
      });
    }

    wake() {
      if (this.raf || document.hidden) return this.draw();
      this.last = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this.step(dt, now);
        this.draw(now);
        const busy = this.flowing || this.grains.length || Math.abs(this.target - this.progress) > 0.0005;
        this.raf = busy && !document.hidden ? requestAnimationFrame(loop) : 0;
      };
      this.raf = requestAnimationFrame(loop);
    }

    step(dt) {
      this.progress += (this.target - this.progress) * Math.min(1, dt * 4);
      if (Math.abs(this.target - this.progress) < 0.0005) this.progress = this.target;
      if (this.flowing && this.progress < 0.999) {
        const n = Math.random() < dt * 70 ? 1 : 0;
        for (let i = 0; i < n + (Math.random() < dt * 40 ? 1 : 0); i++) {
          this.grains.push({ y: YN + 1, x: CX + (Math.random() - 0.5) * 1.2, v: 30 + Math.random() * 25 });
        }
      }
      const floor = this.pileTop();
      this.grains = this.grains.filter((g) => {
        g.v += 260 * dt;
        g.y += g.v * dt;
        g.x += (Math.random() - 0.5) * 0.15;
        return g.y < floor;
      });
    }

    pileTop() {
      return this.bottomPile().peak;
    }

    // Bottom pile: a flat fill plus a cone on top.
    bottomPile() {
      const amount = SAND * this.progress;
      const cone = Math.min(13, 4 + amount / SAND * 30);
      const coneArea = cone * MAXW * 0.9;
      const flat = Math.max(0, amount - coneArea);
      // The flat fill covers the far end of the bulb, so its surface sits where the
      // area between the neck and the surface equals what is left empty.
      const level = YN + depthFor(BULB - flat);
      const scale = amount < coneArea ? amount / coneArea : 1;
      return { level, cone: cone * scale, peak: level - cone * scale };
    }

    draw(now = performance.now()) {
      const { ctx, canvas } = this;
      const s = canvas.width / W;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const r = this.reveal;
      const ease = 1 - Math.pow(1 - r, 3);

      // glass outline path
      const glass = new Path2D();
      glass.moveTo(CX - halfWidth(Y0), Y0);
      for (let y = Y0; y <= Y1; y += 1) glass.lineTo(CX - halfWidth(y), y);
      for (let y = Y1; y >= Y0; y -= 1) glass.lineTo(CX + halfWidth(y), y);
      glass.closePath();

      ctx.globalAlpha = ease;
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fill(glass);

      if (r >= 1) this.drawSand(glass, now);

      // glass edges, drawn in on startup
      ctx.save();
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = 'rgba(236,230,218,0.42)';
      ctx.setLineDash([400 * ease, 400]);
      ctx.stroke(glass);
      ctx.restore();
      // reflection
      ctx.globalAlpha = ease * 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let y = Y0 + 8; y < YN - 14; y += 1) ctx.lineTo(CX - halfWidth(y) + 5, y);
      ctx.stroke();
      ctx.beginPath();
      for (let y = YN + 16; y < Y1 - 8; y += 1) ctx.lineTo(CX - halfWidth(y) + 5, y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // brass frame: caps slide in, posts grow
      const capW = 104 * (0.4 + 0.6 * ease);
      const brass = ctx.createLinearGradient(0, 0, W, 0);
      brass.addColorStop(0, '#6f5a32');
      brass.addColorStop(0.45, '#d8bb7b');
      brass.addColorStop(1, '#7a6236');
      ctx.fillStyle = brass;
      ctx.globalAlpha = ease;
      for (const y of [7, H - 16]) {
        ctx.beginPath();
        ctx.roundRect(CX - capW / 2, y, capW, 9, 3);
        ctx.fill();
      }
      ctx.fillRect(15, 16, 2.2, (H - 32) * ease);
      ctx.fillRect(W - 17.2, 16, 2.2, (H - 32) * ease);
      ctx.globalAlpha = 1;
    }

    drawSand(glass, now) {
      const { ctx } = this;
      ctx.save();
      ctx.clip(glass);
      const grad = ctx.createLinearGradient(0, Y0, 0, Y1);
      grad.addColorStop(0, '#ffd892');
      grad.addColorStop(0.5, '#f4b860');
      grad.addColorStop(1, '#d98a35');

      // top bulb: sand sits on the neck, with a small dip while it drains
      const topAmount = SAND * (1 - this.progress);
      if (topAmount > 0.5) {
        const surface = YN - depthFor(topAmount);
        const hw = halfWidth(surface);
        const dip = this.flowing ? Math.min(6, (YN - surface) * 0.35) : 0;
        const top = new Path2D();
        top.moveTo(CX - hw - 1, surface);
        top.quadraticCurveTo(CX, surface + dip * 2, CX + hw + 1, surface);
        top.lineTo(CX + NECK + 2, YN + 1);
        top.lineTo(CX - NECK - 2, YN + 1);
        top.closePath();
        this.fillSand(top, grad);
        // sparkles on the surface
        for (const sp of this.sparkles) {
          const a = Math.max(0, Math.sin(now / 600 + sp.phase));
          ctx.fillStyle = `rgba(255,250,230,${a * 0.8})`;
          ctx.fillRect(CX - hw + 4 + sp.x * (hw * 2 - 8), surface + 1.5 + dip * (1 - Math.abs(sp.x - 0.5) * 2), 0.9, 0.9);
        }
      }

      // bottom pile
      const pile = this.bottomPile();
      if (this.progress > 0.001) {
        const hw = halfWidth(pile.level);
        const bottom = new Path2D();
        bottom.moveTo(CX - hw - 1, pile.level);
        bottom.quadraticCurveTo(CX - hw * 0.35, pile.level, CX, pile.peak);
        bottom.quadraticCurveTo(CX + hw * 0.35, pile.level, CX + hw + 1, pile.level);
        bottom.lineTo(CX + MAXW + 2, Y1 + 2);
        bottom.lineTo(CX - MAXW - 2, Y1 + 2);
        bottom.closePath();
        this.fillSand(bottom, grad);
      }

      // the stream
      if (this.grains.length) {
        ctx.fillStyle = '#ffd28a';
        for (const g of this.grains) ctx.fillRect(g.x - 0.45, g.y, 0.9, 1.6);
        if (this.flowing) {
          ctx.fillStyle = 'rgba(255,210,138,0.35)';
          ctx.fillRect(CX - 0.35, YN, 0.7, pile.peak - YN);
        }
      }
      ctx.restore();
    }

    fillSand(path, grad) {
      const { ctx } = this;
      ctx.fillStyle = grad;
      ctx.fill(path);
      ctx.fillStyle = this.pattern;
      ctx.fill(path);
    }
  }

  window.Hourglass = Hourglass;
})();
