/**
 * The wordless "data → action" backdrop for the auth screen.
 *
 * A flow-field particle system, read as a short film with no captions:
 *   · scattered points drift as raw, noisy data
 *   · a slowly-evolving vector field pulls them into coherent streams (signal
 *     emerging — measure → diagnose)
 *   · streams converge and, at intervals, a point blooms warm (an action
 *     executed — the cool data becomes a warm, deployed fix)
 * Motion trails + two depth layers give it a cinematic, camera-like drift.
 *
 * Pure Canvas 2D, self-contained, no deps — runs in the app and in the
 * sandboxed shareable preview alike. Honors prefers-reduced-motion.
 */
export interface BackdropHandle {
  stop(): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  layer: 0 | 1; // 0 = far (dim/slow), 1 = near (bright/fast)
}

interface Bloom {
  x: number;
  y: number;
  r: number;
  age: number;
  ttl: number;
}

const BG = '#070b16';

/** Smoothly-evolving flow direction (radians) at a point and time. */
function fieldAngle(x: number, y: number, t: number): number {
  const s = 0.0016;
  return (
    Math.sin(x * s + t * 0.2) +
    Math.cos(y * s * 1.1 - t * 0.15) +
    Math.sin((x + y) * s * 0.6 + t * 0.1)
  ) * Math.PI;
}

export function startAuthBackdrop(canvas: HTMLCanvasElement): BackdropHandle {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let particles: Particle[] = [];
  const blooms: Bloom[] = [];

  function spawn(layer: 0 | 1, atEdge = false): Particle {
    const max = 120 + Math.random() * 220;
    let x = Math.random() * w;
    let y = Math.random() * h;
    if (atEdge) {
      // seed from the left third so streams sweep across — cinematic entrance
      x = Math.random() * w * 0.4 - w * 0.05;
      y = Math.random() * h;
    }
    return { x, y, vx: 0, vy: 0, life: Math.random() * max, max, layer };
  }

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const area = w * h;
    const far = Math.min(2600, Math.floor(area / 900));
    const near = Math.min(900, Math.floor(area / 2600));
    particles = [];
    for (let i = 0; i < far; i++) particles.push(spawn(0));
    for (let i = 0; i < near; i++) particles.push(spawn(1));

    // paint the ground once so the first trails have something to fade into
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
  }

  function drawStaticFrame(): void {
    // reduced-motion: a calm, resolved field — a few clean streams, no motion
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const t = 12;
    for (const p of particles) {
      let x = p.x;
      let y = p.y;
      ctx.strokeStyle = p.layer ? 'rgba(150,190,255,0.10)' : 'rgba(120,160,240,0.05)';
      ctx.lineWidth = p.layer ? 1.1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let i = 0; i < 22; i++) {
        const a = fieldAngle(x, y, t);
        x += Math.cos(a) * 6;
        y += Math.sin(a) * 6;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  let raf = 0;
  let t = 0;
  let bloomTimer = 90;

  function frame(): void {
    t += 0.0016;

    // fade previous frame → motion trails
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(7,11,22,0.11)';
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const a = fieldAngle(p.x, p.y, t);
      const force = p.layer ? 0.16 : 0.1;
      const speed = p.layer ? 2.4 : 1.4;
      p.vx += Math.cos(a) * force;
      p.vy += Math.sin(a) * force;
      // damping + clamp toward a steady stream speed
      p.vx *= 0.92;
      p.vy *= 0.92;
      const px = p.x;
      const py = p.y;
      p.x += p.vx * speed;
      p.y += p.vy * speed;
      p.life++;

      const mag = Math.hypot(p.vx, p.vy);
      const bright = Math.min(1, mag * (p.layer ? 0.9 : 0.7));
      if (p.layer) {
        ctx.strokeStyle = `rgba(${140 + bright * 90},${180 + bright * 50},255,${0.10 + bright * 0.5})`;
        ctx.lineWidth = 1.2;
      } else {
        ctx.strokeStyle = `rgba(110,150,235,${0.04 + bright * 0.16})`;
        ctx.lineWidth = 0.75;
      }
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      if (
        p.life > p.max ||
        p.x < -40 ||
        p.x > w + 40 ||
        p.y < -40 ||
        p.y > h + 40
      ) {
        Object.assign(p, spawn(p.layer, Math.random() < 0.6));
      }
    }

    // execution blooms — a stream culminates in an action
    bloomTimer--;
    if (bloomTimer <= 0 && particles.length) {
      const seed = particles[(Math.random() * particles.length) | 0]!;
      if (seed.layer === 1 && seed.x > w * 0.15 && seed.x < w * 0.95) {
        blooms.push({ x: seed.x, y: seed.y, r: 0, age: 0, ttl: 70 });
        bloomTimer = 70 + Math.random() * 90;
      } else {
        bloomTimer = 12;
      }
    }
    for (let i = blooms.length - 1; i >= 0; i--) {
      const b = blooms[i]!;
      b.age++;
      const p = b.age / b.ttl;
      b.r = 4 + p * 46;
      const fade = 1 - p;
      // cool ring resolving outward
      ctx.strokeStyle = `rgba(120,165,255,${0.5 * fade * fade})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
      // warm core — the executed action
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 10 + p * 8);
      g.addColorStop(0, `rgba(255,190,120,${0.9 * fade})`);
      g.addColorStop(1, 'rgba(255,150,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 10 + p * 8, 0, Math.PI * 2);
      ctx.fill();
      if (b.age >= b.ttl) blooms.splice(i, 1);
    }

    ctx.globalCompositeOperation = 'source-over';
    raf = requestAnimationFrame(frame);
  }

  resize();
  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  if (reduced) {
    drawStaticFrame();
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
  };
}
