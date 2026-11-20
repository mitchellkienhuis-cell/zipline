"use strict";

// Zip Dash: the waiting-room game. A parcel rides a zipline. Tap (or press
// space) to hop, tap again in the air for a second hop.
//
//   knots     on the cable        hop over them
//   lanterns  hanging above       stay low
//   birds     flying at you       get under or over
//   packets   to collect          chains build a multiplier
//   bolt      power-up            a few seconds of unstoppable boost + magnet
//   bubble    power-up            a shield that absorbs one hit
//
// The game is wired to the real transfer: a faster link gives a tailwind,
// every percent the transfer advances drops a gold packet on the line, and
// when it lands a finish arch appears with a delivery bonus.

(() => {
  const W = 840, H = 420;          // logical size; the canvas is scaled for sharp screens
  const RIDER_X = 170;
  const GRAVITY = 2300, HOP = 760;
  const canvas = document.getElementById("game-canvas");
  const scoreEl = document.getElementById("game-score");
  const bestEl = document.getElementById("game-best");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  let frame = 0, last = 0, clock = 0;
  let mode = "ready";               // ready | playing | over
  let lift = 0, vy = 0, hops = 0;   // height above the cable, vertical speed, hops since landing
  let distance = 0, speed = 0, nextAt = 0;
  let things = [];                  // obstacles, pickups, the finish arch
  let sparks = [];                  // particles
  let score = 0, packets = 0, chain = 0, chainTimer = 0;
  let boost = 0, shield = false, shake = 0, banner = null;
  let best = 0;
  try { best = Number(localStorage.getItem("zipdash-best")) || 0; } catch { /* private mode */ }

  // What the real transfer is doing (fed by the app).
  const link = { active: false, progress: 0, speed: 0, done: false };
  let goldQueue = 0, lastPercent = -1, archPending = false, archShown = false;

  const cableY = (x) => 268 + (x - W / 2) * 0.07; // the line slopes gently downhill
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const multiplier = () => Math.min(5, 1 + Math.floor(chain / 5));
  const tailwind = () => (link.active ? 1 + Math.min(0.25, link.speed / 4e8) : 1);

  function reset() {
    mode = "ready"; lift = 0; vy = 0; hops = 0; distance = 0; speed = 290; nextAt = 520;
    things = []; sparks = []; score = 0; packets = 0; chain = 0; chainTimer = 0;
    boost = 0; shield = false; shake = 0; banner = null;
    archShown = false; archPending = link.done;
    showScore();
  }

  function showScore() {
    scoreEl.textContent = `${Math.floor(score)} pts`;
    bestEl.textContent = best ? `Best ${best}` : "";
  }

  function hop() {
    if (mode === "ready") mode = "playing";
    else if (mode === "over") { reset(); mode = "playing"; }
    if (mode === "playing" && hops < 2) {
      vy = hops === 0 ? HOP : HOP * 0.82;
      hops += 1;
      burst(RIDER_X, cableY(RIDER_X) - lift, 5, "#ffffff");
    }
  }

  function burst(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 180;
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.5 + Math.random() * 0.3, color });
    }
  }

  function say(text, color) { banner = { text, color, life: 1.6 }; }

  // ---- spawning: one "set piece" at a time, harder ones as the run goes on
  function spawn() {
    const x = W + 60;
    const level = Math.min(1, distance / 9000);
    const roll = Math.random();
    if (archPending && !archShown) {
      things.push({ x: x + 120, kind: "arch" });
      archShown = true; archPending = false;
    } else if (goldQueue > 0 && roll < 0.5) {
      goldQueue -= 1;
      things.push({ x, kind: "packet", h: 70, gold: true });
    } else if (roll < 0.14 && distance > 1200) {
      things.push({ x, kind: Math.random() < 0.55 ? "bolt" : "bubble", h: 80 });
    } else if (roll < 0.36) {
      // A rainbow of packets to hop through.
      for (let i = 0; i < 5; i++) things.push({ x: x + i * 46, kind: "packet", h: 26 + Math.sin((i / 4) * Math.PI) * 92 });
    } else if (roll < 0.5) {
      for (let i = 0; i < 4; i++) things.push({ x: x + i * 52, kind: "packet", h: 0 });
    } else if (roll < 0.5 + 0.2 * level && distance > 2200) {
      things.push({ x: x + 80, kind: "bird", h: 60 + Math.random() * 70, phase: Math.random() * 6 });
    } else if (roll < 0.78 && distance > 1500) {
      things.push({ x, kind: "lantern" });
      things.push({ x: x + 4, kind: "packet", h: 0 });
    } else {
      things.push({ x, kind: "knot" });
      if (level > 0.35 && Math.random() < 0.4) things.push({ x: x + 150, kind: "knot" });
      things.push({ x: x + 2, kind: "packet", h: 84 });
    }
    nextAt = distance + Math.max(300, speed * (0.8 + Math.random() * 0.6 - level * 0.2));
  }

  function collect(t) {
    packets += 1; chain += 1; chainTimer = 2.6;
    const gain = (t.gold ? 60 : 10) * multiplier();
    score += gain;
    burst(RIDER_X + 10, cableY(RIDER_X) - lift, t.gold ? 16 : 7, t.gold ? "#ffc53d" : "#2ad0ff");
    if (chain > 0 && chain % 5 === 0 && multiplier() <= 5) say(`×${multiplier()} chain`, "#2ad0ff");
  }

  function crash() {
    if (boost > 0) return;
    if (shield) { shield = false; shake = 0.25; chain = 0; say("Shield popped", "#8f7bff"); burst(RIDER_X, cableY(RIDER_X) - lift, 18, "#8f7bff"); return; }
    mode = "over"; shake = 0.45;
    burst(RIDER_X, cableY(RIDER_X) - lift, 26, "#ff6b76");
    const final = Math.floor(score);
    if (final > best) {
      best = final;
      try { localStorage.setItem("zipdash-best", String(best)); } catch { /* ignore */ }
    }
  }

  function update(dt) {
    clock += dt;
    shake = Math.max(0, shake - dt);
    if (banner && (banner.life -= dt) <= 0) banner = null;
    for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 500 * dt; s.life -= dt; }
    sparks = sparks.filter((s) => s.life > 0);
    if (mode !== "playing") return;

    boost = Math.max(0, boost - dt);
    if (chainTimer > 0 && (chainTimer -= dt) <= 0) chain = 0;
    speed = Math.min(640, 290 + distance / 60) * tailwind() * (boost > 0 ? 1.35 : 1);
    distance += speed * dt;
    score += (speed * dt) / 24;
    vy -= GRAVITY * dt;
    lift = Math.max(0, lift + vy * dt);
    if (lift === 0) { vy = 0; hops = 0; }
    if (distance >= nextAt) spawn();

    for (const t of things) {
      t.x -= (t.kind === "bird" ? speed * 1.25 : speed) * dt;
      if (t.kind === "bird") t.h += Math.sin(clock * 3 + t.phase) * 40 * dt;
      if (t.gone) continue;
      const dx = t.x - RIDER_X, near = Math.abs(dx) < 26;
      if (t.kind === "packet") {
        // The boost pulls packets in.
        if (boost > 0 && dx < 240 && dx > -20) { t.h += (lift - t.h) * Math.min(1, dt * 9); t.x -= 260 * dt; }
        if (Math.abs(dx) < 30 && Math.abs(lift - t.h) < 34) { t.gone = true; collect(t); }
      } else if (t.kind === "bolt" || t.kind === "bubble") {
        if (Math.abs(dx) < 30 && Math.abs(lift - t.h) < 40) {
          t.gone = true;
          if (t.kind === "bolt") { boost = 4.5; say("Boost!", "#ffc53d"); } else { shield = true; say("Shield up", "#8f7bff"); }
          burst(RIDER_X, cableY(RIDER_X) - lift, 20, t.kind === "bolt" ? "#ffc53d" : "#8f7bff");
        }
      } else if (t.kind === "arch") {
        if (dx < 0) { t.gone = true; score += 500; say("Delivered! +500", "#3fcf8a"); burst(RIDER_X, cableY(RIDER_X) - lift - 20, 40, "#3fcf8a"); }
      } else if (near) {
        const hit = t.kind === "knot" ? lift < 20 : t.kind === "lantern" ? lift > 38 : Math.abs(lift - t.h) < 30;
        if (hit) { t.gone = boost > 0 || shield; crash(); }
      }
    }
    things = things.filter((t) => t.x > -80 && !(t.gone && t.kind !== "arch"));
    showScore();
  }

  // ------------------------------------------------------------- drawing

  function sky() {
    // Day slides into dusk and night as the run gets longer.
    const t = Math.min(1, distance / 14000);
    const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const top = mix([120, 190, 255], [18, 14, 60]), bottom = mix([226, 240, 255], [70, 50, 140]);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgb(${top})`); g.addColorStop(1, `rgb(${bottom})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (t > 0.45) {
      ctx.fillStyle = `rgba(255,255,255,${(t - 0.45) * 1.6})`;
      for (let i = 0; i < 40; i++) {
        const x = (i * 97 + 31 - distance * 0.02) % W;
        ctx.fillRect((x + W) % W, (i * 53) % 190, 2, 2);
      }
    }
    // Clouds
    ctx.fillStyle = `rgba(255,255,255,${0.75 - t * 0.5})`;
    for (let i = 0; i < 4; i++) {
      const x = ((i * 260 - distance * 0.06) % (W + 200) + W + 200) % (W + 200) - 100, y = 40 + i * 28;
      ctx.beginPath(); ctx.ellipse(x, y, 60, 16, 0, 0, Math.PI * 2); ctx.ellipse(x + 40, y + 8, 46, 13, 0, 0, Math.PI * 2); ctx.fill();
    }
    return t;
  }

  function draw() {
    const accent = css("--accent") || "#5b54f5", accent2 = css("--accent-2") || "#14b8f0";
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 14 * shake * 3, (Math.random() - 0.5) * 10 * shake * 3);
    const night = sky();
    const ink = night > 0.5 ? "#f2f3ff" : "#1b1e2e";

    for (const [depth, alpha, base] of [[0.12, 0.22, 338], [0.3, 0.34, 372]]) {
      ctx.fillStyle = accent; ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 20) {
        const wx = x + distance * depth;
        ctx.lineTo(x, base - 34 * Math.sin(wx / 170) - 18 * Math.sin(wx / 61));
      }
      ctx.lineTo(W, H); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Speed lines while boosted.
    if (boost > 0 && mode === "playing") {
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
      for (let i = 0; i < 9; i++) {
        const y = 60 + i * 34, x = W - ((distance * 3 + i * 211) % (W + 200));
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 90, y); ctx.stroke();
      }
    }

    // Pylons and the cable.
    ctx.strokeStyle = night > 0.5 ? "rgba(255,255,255,.25)" : "rgba(27,30,46,.18)"; ctx.lineWidth = 6;
    for (let px = W - (distance % 520); px > -20; px -= 520) {
      ctx.beginPath(); ctx.moveTo(px, cableY(px)); ctx.lineTo(px, H); ctx.stroke();
    }
    ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-10, cableY(-10)); ctx.lineTo(W + 10, cableY(W + 10)); ctx.stroke();

    for (const t of things) {
      const y = cableY(t.x);
      if (t.kind === "knot") {
        ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(t.x, y, 11, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(t.x - 9, y - 14); ctx.lineTo(t.x + 9, y - 14); ctx.stroke();
      } else if (t.kind === "lantern") {
        ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(t.x, 0); ctx.lineTo(t.x, y - 104); ctx.stroke();
        ctx.shadowColor = "#f5a524"; ctx.shadowBlur = 22 * (0.4 + night);
        ctx.fillStyle = "#f5a524"; ctx.beginPath(); ctx.roundRect(t.x - 13, y - 104, 26, 56, 9); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.beginPath(); ctx.roundRect(t.x - 6, y - 94, 12, 36, 5); ctx.fill();
      } else if (t.kind === "bird") {
        const by = y - t.h, flap = Math.sin(clock * 16 + t.phase) * 10;
        ctx.strokeStyle = ink; ctx.lineWidth = 4; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(t.x - 18, by - flap); ctx.lineTo(t.x, by); ctx.lineTo(t.x + 18, by - flap); ctx.stroke();
        ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(t.x - 3, by + 2, 5, 0, Math.PI * 2); ctx.fill();
      } else if (t.kind === "packet") {
        const py = y - t.h - 16 + Math.sin(clock * 5 + t.x / 40) * 3;
        ctx.shadowColor = t.gold ? "#ffc53d" : accent2; ctx.shadowBlur = 14;
        ctx.fillStyle = t.gold ? "#ffc53d" : accent2;
        ctx.beginPath(); ctx.roundRect(t.x - 9, py - 9, 18, 18, 5); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fillRect(t.x - 5, py - 1.500, 10, 3);
      } else if (t.kind === "bolt" || t.kind === "bubble") {
        const py = y - t.h - 16 + Math.sin(clock * 4) * 5, col = t.kind === "bolt" ? "#ffc53d" : "#8f7bff";
        ctx.shadowColor = col; ctx.shadowBlur = 24;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(t.x, py, 17, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.fillStyle = "#fff";
        if (t.kind === "bolt") { ctx.beginPath(); ctx.moveTo(t.x + 3, py - 12); ctx.lineTo(t.x - 8, py + 2); ctx.lineTo(t.x - 1, py + 2); ctx.lineTo(t.x - 4, py + 12); ctx.lineTo(t.x + 8, py - 3); ctx.lineTo(t.x + 1, py - 3); ctx.closePath(); ctx.fill(); }
        else { ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(t.x, py, 8, 0, Math.PI * 2); ctx.stroke(); }
      } else if (t.kind === "arch" && !t.gone) {
        ctx.strokeStyle = "#3fcf8a"; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(t.x, H); ctx.lineTo(t.x, y - 150); ctx.stroke();
        ctx.fillStyle = "#3fcf8a"; ctx.beginPath(); ctx.roundRect(t.x - 4, y - 150, 120, 34, 8); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "700 17px -apple-system, 'Segoe UI', sans-serif"; ctx.textAlign = "left";
        ctx.fillText("DELIVERED", t.x + 12, y - 127);
      }
    }

    // The rider.
    const ry = cableY(RIDER_X) - lift;
    const swing = mode === "playing" ? Math.sin(distance / 55) * 0.12 - vy / 9000 : 0;
    if (boost > 0) {
      const trail = ctx.createLinearGradient(RIDER_X - 120, 0, RIDER_X, 0);
      trail.addColorStop(0, "rgba(255,197,61,0)"); trail.addColorStop(1, "rgba(255,197,61,.75)");
      ctx.fillStyle = trail; ctx.fillRect(RIDER_X - 120, ry + 22, 120, 38);
    }
    ctx.save(); ctx.translate(RIDER_X, ry);
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(0, -3, 7, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(swing);
    ctx.strokeStyle = ink; ctx.lineWidth = 2.500;
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(0, 24); ctx.stroke();
    const g = ctx.createLinearGradient(-20, 24, 20, 58);
    g.addColorStop(0, boost > 0 ? "#ffb020" : accent); g.addColorStop(1, boost > 0 ? "#ffd86b" : accent2);
    ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(-20, 24, 40, 34, 8); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 24); ctx.lineTo(0, 58); ctx.moveTo(-20, 41); ctx.lineTo(20, 41); ctx.stroke();
    if (shield) {
      ctx.strokeStyle = "rgba(143,123,255,.9)"; ctx.lineWidth = 3; ctx.fillStyle = "rgba(143,123,255,.16)";
      ctx.beginPath(); ctx.arc(0, 34, 40 + Math.sin(clock * 6) * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();

    for (const s of sparks) {
      ctx.globalAlpha = Math.max(0, s.life * 1.6); ctx.fillStyle = s.color;
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    ctx.globalAlpha = 1;

    // Heads-up line: packets, chain, power-ups, tailwind.
    ctx.font = "700 17px -apple-system, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = ink;
    let hud = `▣ ${packets}`;
    if (multiplier() > 1) hud += `   ×${multiplier()}`;
    if (boost > 0) hud += `   ⚡ ${boost.toFixed(1)}s`;
    if (shield) hud += "   ◯ shield";
    ctx.fillText(hud, 18, 30);
    if (tailwind() > 1.02) { ctx.textAlign = "right"; ctx.fillText(`Tailwind ×${tailwind().toFixed(2)}`, W - 18, 30); }

    if (banner) {
      ctx.globalAlpha = Math.min(1, banner.life * 2); ctx.textAlign = "center";
      ctx.font = "800 34px -apple-system, 'Segoe UI', sans-serif"; ctx.fillStyle = banner.color;
      ctx.fillText(banner.text, W / 2, 96 - (1.6 - banner.life) * 14);
      ctx.globalAlpha = 1;
    }
    if (mode !== "playing") {
      ctx.fillStyle = ink; ctx.textAlign = "center";
      ctx.font = "800 32px -apple-system, 'Segoe UI', sans-serif";
      ctx.fillText(mode === "ready" ? "Tap to ride" : "Snagged!", W / 2, 150);
      ctx.font = "500 17px -apple-system, 'Segoe UI', sans-serif";
      ctx.fillText(mode === "ready" ? "Tap to hop, tap again in the air. Grab packets, dodge the rest." : `${Math.floor(score)} points · ${packets} packets · tap to go again`, W / 2, 180);
    }
    ctx.restore();
  }

  function tick(now) {
    const dt = Math.min(0.04, (now - last) / 1000 || 0);
    last = now;
    update(dt);
    draw();
    frame = requestAnimationFrame(tick);
  }

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); hop(); });
  document.addEventListener("keydown", (e) => {
    if (!frame || (e.code !== "Space" && e.code !== "ArrowUp")) return;
    e.preventDefault();
    hop();
  });

  // A frozen mid-run frame, for screenshots.
  function demo() {
    fit(); reset();
    mode = "playing"; distance = 5200; speed = 420; lift = 78; vy = 160; clock = 1.3;
    score = 1840; packets = 37; chain = 11; boost = 2.8; shield = true;
    link.active = true; link.speed = 112e6;
    things = [{ x: 250, kind: "knot" }, { x: 480, kind: "lantern" }, { x: 640, kind: "bird", h: 96, phase: 1 }, { x: 760, kind: "bolt", h: 80 }];
    for (let i = 0; i < 5; i++) things.push({ x: 300 + i * 46, kind: "packet", h: 26 + Math.sin((i / 4) * Math.PI) * 92, gold: i === 2 });
    showScore(); draw();
  }

  window.ZipDash = {
    demo,
    start() { fit(); reset(); canvas.tabIndex = 0; canvas.focus({ preventScroll: true }); cancelAnimationFrame(frame); last = performance.now(); frame = requestAnimationFrame(tick); },
    stop() { cancelAnimationFrame(frame); frame = 0; },
    // Called by the app whenever the transfer in flight changes.
    setTransfer(t) {
      link.active = !!t.active; link.speed = t.speed || 0; link.progress = t.progress || 0;
      const percent = Math.floor(link.progress * 100);
      if (link.active && lastPercent >= 0 && percent > lastPercent) goldQueue = Math.min(6, goldQueue + (percent - lastPercent));
      lastPercent = link.active ? percent : -1;
      if (t.done && !link.done && mode === "playing") archPending = true;
      link.done = !!t.done;
    },
  };
})();
