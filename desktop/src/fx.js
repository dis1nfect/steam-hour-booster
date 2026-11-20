'use strict';

// Full-window particle layer: crumbling an element into sand, and faint dust motes.
(() => {
  const SAND = ['#f4b860', '#ffd892', '#e39a45', '#f8c77d', '#ece6da', '#b99a5b'];
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  class Fx {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.parts = [];
      this.motes = [];
      this.ambient = false;
      this.raf = 0;
      this.resize();
      addEventListener('resize', () => this.resize());
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.w = innerWidth;
      this.h = innerHeight;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setAmbient(on) {
      this.ambient = on;
      if (on && !this.motes.length) {
        this.motes = Array.from({ length: 28 }, () => this.newMote(true));
      }
      this.run();
    }

    newMote(anywhere) {
      return {
        x: Math.random() * this.w,
        y: anywhere ? Math.random() * this.h : this.h + 5,
        r: 0.6 + Math.random() * 1.2,
        v: 4 + Math.random() * 10,
        a: 0.06 + Math.random() * 0.22,
        sway: Math.random() * 6.28,
      };
    }

    /**
     * Crumble `el` into sand that streams to `target` ({x, y} in window pixels).
     * The element is wiped away top to bottom while grains peel off its edge.
     */
    dissolve(el, target, duration = 1300) {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
      }
      const rect = el.getBoundingClientRect();
      const count = Math.round(Math.min(1800, Math.max(500, (rect.width * rect.height) / 45)));
      const wipe = duration * 0.45;
      const now = performance.now();
      for (let i = 0; i < count; i++) {
        const x = rect.left + Math.random() * rect.width;
        const y = rect.top + Math.random() * rect.height;
        const delay = ((y - rect.top) / rect.height) * wipe + Math.random() * 90;
        this.parts.push({
          x0: x, y0: y,
          cx: x + (Math.random() - 0.5) * 120, cy: y + 30 + Math.random() * 110,
          x1: target.x + (Math.random() - 0.5) * 10, y1: target.y + (Math.random() - 0.5) * 6,
          start: now + delay,
          life: duration * (0.55 + Math.random() * 0.3),
          size: 1 + Math.random() * 1.4,
          color: SAND[(Math.random() * SAND.length) | 0],
        });
      }
      el.animate(
        [{ clipPath: 'inset(0 0 0 0)', opacity: 1 }, { clipPath: 'inset(100% 0 0 0)', opacity: 0.6 }],
        { duration: wipe + 90, easing: 'linear', fill: 'forwards' },
      );
      this.run();
      return new Promise((resolve) => setTimeout(resolve, duration * 0.85));
    }

    run() {
      if (this.raf) return;
      let last = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        this.frame(now, dt);
        this.raf = this.parts.length || this.ambient ? requestAnimationFrame(loop) : 0;
        if (!this.raf) this.ctx.clearRect(0, 0, this.w, this.h);
      };
      this.raf = requestAnimationFrame(loop);
    }

    frame(now, dt) {
      const { ctx } = this;
      ctx.clearRect(0, 0, this.w, this.h);

      if (this.ambient) {
        for (let i = 0; i < this.motes.length; i++) {
          const m = this.motes[i];
          m.y -= m.v * dt;
          m.sway += dt * 0.6;
          if (m.y < -5) this.motes[i] = this.newMote(false);
          ctx.globalAlpha = m.a;
          ctx.fillStyle = '#f4b860';
          ctx.beginPath();
          ctx.arc(m.x + Math.sin(m.sway) * 8, m.y, m.r, 0, 6.283);
          ctx.fill();
        }
      }

      this.parts = this.parts.filter((p) => {
        if (now < p.start) return true;
        const t = (now - p.start) / p.life;
        if (t >= 1) return false;
        const e = easeInOut(t);
        const u = 1 - e;
        const x = u * u * p.x0 + 2 * u * e * p.cx + e * e * p.x1;
        const y = u * u * p.y0 + 2 * u * e * p.cy + e * e * p.y1;
        ctx.globalAlpha = t > 0.8 ? (1 - t) / 0.2 : 1;
        ctx.fillStyle = p.color;
        ctx.fillRect(x, y, p.size, p.size);
        return true;
      });
      ctx.globalAlpha = 1;
    }
  }

  window.Fx = Fx;
})();
