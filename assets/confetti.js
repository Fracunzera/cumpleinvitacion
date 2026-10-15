/*
 * confetti.js — Confeti mínimo en <canvas>. Licencia MIT. Sin dependencias.
 *
 * Uso: Confetti.burst({ colors: ["#f00", "#0f0"], count: 160 });
 * Respeta prefers-reduced-motion (tira muy poquito y lento).
 */
(function (global) {
  "use strict";

  var canvas = null, ctx = null, parts = [], raf = 0, last = 0, dpr = 1;

  function reducedMotion() {
    return global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function setup() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "confetti-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    resize();
    global.addEventListener("resize", resize);
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.width = Math.round(global.innerWidth * dpr);
    canvas.height = Math.round(global.innerHeight * dpr);
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function burst(opts) {
    opts = opts || {};
    setup();
    var colors = opts.colors && opts.colors.length ? opts.colors : ["#ff4f8b", "#ffc93c", "#2ec4b6", "#7b5cff", "#ff8a3d"];
    var reduced = reducedMotion();
    var count = reduced ? 24 : (opts.count || 160);
    var w = global.innerWidth, h = global.innerHeight;
    for (var i = 0; i < count; i++) {
      var fromLeft = i % 2 === 0;
      var shape = Math.random();
      parts.push({
        x: reduced ? rand(0, w) : (fromLeft ? rand(-20, w * 0.15) : rand(w * 0.85, w + 20)),
        y: reduced ? rand(-40, -10) : rand(h * 0.55, h * 0.9),
        vx: reduced ? rand(-15, 15) : (fromLeft ? rand(80, 420) : rand(-420, -80)),
        vy: reduced ? rand(40, 90) : rand(-950, -500),
        w: rand(6, 11),
        h: rand(8, 16),
        rot: rand(0, Math.PI * 2),
        vr: reduced ? 0 : rand(-8, 8),
        tilt: rand(0, Math.PI * 2),
        color: colors[i % colors.length],
        kind: shape < 0.6 ? "rect" : shape < 0.85 ? "circle" : "strip",
        life: 0,
        maxLife: reduced ? 4 : rand(3.2, 5)
      });
    }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }

  function tick(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    var h = global.innerHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life += dt;
      p.vy += 900 * dt * (p.vy > 0 ? 0.35 : 1); // cae más lento que sube
      p.vx *= 1 - 1.6 * dt;
      if (p.vy > 220) p.vy = 220;
      p.x += (p.vx + Math.sin(p.life * 3 + p.tilt) * 30) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > h + 40 || p.life > p.maxLife) { parts.splice(i, 1); continue; }
      var alpha = Math.min(1, (p.maxLife - p.life) * 2);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      var flip = Math.abs(Math.cos(p.life * 6 + p.tilt));
      if (p.kind === "circle") {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.w / 2, (p.w / 2) * flip + 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === "strip") {
        ctx.fillRect(-1.5, -p.h, 3, p.h * 2 * flip + 1);
      } else {
        ctx.fillRect(-p.w / 2, (-p.h / 2) * flip, p.w, p.h * flip + 0.5);
      }
      ctx.restore();
    }
    if (parts.length) raf = requestAnimationFrame(tick);
    else { raf = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }

  global.Confetti = { burst: burst };
})(this);
