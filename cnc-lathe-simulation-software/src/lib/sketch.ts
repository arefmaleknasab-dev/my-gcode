/* ------------------------------------------------------------------ */
/*  موتور اسکچ — خط، منحنی درجه۲/۳ و کمان سه‌نقطه‌ای برای طراحی پروفایل   */
/*  مختصات: z = طول قطعه (محور X نمایش) ، r = شعاع (محور Y نمایش)        */
/* ------------------------------------------------------------------ */

import type { PPoint } from "./lathe";

export interface SPoint {
  z: number;
  r: number;
}

export type SketchKind = "line" | "quad" | "cubic" | "arc";

export interface SketchSeg {
  id: number;
  kind: SketchKind;
  a: SPoint; // نقطه شروع
  b: SPoint; // نقطه پایان
  c1?: SPoint; // منحنی درجه۲: تنها نقطه کنترل | درجه۳: دستهٔ اول
  c2?: SPoint; // منحنی درجه۳: دستهٔ دوم
  via?: SPoint; // کمان: نقطهٔ روی کمان
}

export const KIND_FA: Record<SketchKind, string> = {
  line: "خط",
  quad: "منحنی ساده",
  cubic: "منحنی کنترلی",
  arc: "کمان",
};

let segUid = 5000;
export const newSegId = () => ++segUid;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist = (p: SPoint, q: SPoint) => Math.hypot(p.z - q.z, p.r - q.r);

/* ---------------- کمان از سه نقطه ---------------- */

export interface ArcInfo {
  center: SPoint;
  radius: number;
  a0: number; // زاویه شروع
  sweep: number; // بازهٔ زاویه (علامت = جهت)
}

export function arcInfo(s: SketchSeg): ArcInfo | null {
  const { a, b, via } = s;
  if (!via) return null;
  const d = 2 * (a.z * (via.r - b.r) + via.z * (b.r - a.r) + b.z * (a.r - via.r));
  if (Math.abs(d) < 1e-9) return null; // هم‌خط
  const aa = a.z * a.z + a.r * a.r;
  const mm = via.z * via.z + via.r * via.r;
  const bb = b.z * b.z + b.r * b.r;
  const cz = (aa * (via.r - b.r) + mm * (b.r - a.r) + bb * (a.r - via.r)) / d;
  const cr = (aa * (b.z - via.z) + mm * (a.z - b.z) + bb * (via.z - a.z)) / d;
  const center = { z: cz, r: cr };
  const radius = Math.hypot(a.z - cz, a.r - cr);
  if (!Number.isFinite(radius) || radius > 1e6) return null;
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const a0 = Math.atan2(a.r - cr, a.z - cz);
  const a1 = Math.atan2(b.r - cr, b.z - cz);
  const am = Math.atan2(via.r - cr, via.z - cz);
  const dCCW = norm(a1 - a0);
  const mCCW = norm(am - a0);
  const ccw = mCCW <= dCCW;
  const sweep = ccw ? dCCW : -(TAU - dCCW);
  return { center, radius, a0, sweep };
}

/* ---------------- ارزیابی نقطه روی المان ---------------- */

export function evalSeg(s: SketchSeg, t: number): SPoint {
  const { a, b } = s;
  if (s.kind === "line") return { z: lerp(a.z, b.z, t), r: lerp(a.r, b.r, t) };
  if (s.kind === "quad" && s.c1) {
    const u = 1 - t;
    return {
      z: u * u * a.z + 2 * u * t * s.c1.z + t * t * b.z,
      r: u * u * a.r + 2 * u * t * s.c1.r + t * t * b.r,
    };
  }
  if (s.kind === "cubic" && s.c1 && s.c2) {
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    return {
      z: w0 * a.z + w1 * s.c1.z + w2 * s.c2.z + w3 * b.z,
      r: w0 * a.r + w1 * s.c1.r + w2 * s.c2.r + w3 * b.r,
    };
  }
  if (s.kind === "arc") {
    const info = arcInfo(s);
    if (!info) return { z: lerp(a.z, b.z, t), r: lerp(a.r, b.r, t) };
    const ang = info.a0 + info.sweep * t;
    return { z: info.center.z + info.radius * Math.cos(ang), r: info.center.r + info.radius * Math.sin(ang) };
  }
  return { z: lerp(a.z, b.z, t), r: lerp(a.r, b.r, t) };
}

/** نقاط گسسته روی المان (برای ترسیم و تخت‌سازی) */
export function segPoints(s: SketchSeg, n?: number): SPoint[] {
  if (s.kind === "line") return [s.a, s.b];
  const steps = n ?? Math.max(10, Math.min(90, Math.ceil(segLength(s) / 1.2)));
  const out: SPoint[] = [];
  for (let i = 0; i <= steps; i++) out.push(evalSeg(s, i / steps));
  return out;
}

export function segLength(s: SketchSeg): number {
  if (s.kind === "line") return dist(s.a, s.b);
  if (s.kind === "arc") {
    const info = arcInfo(s);
    if (info) return Math.abs(info.sweep) * info.radius;
  }
  let len = 0;
  let prev = evalSeg(s, 0);
  for (let i = 1; i <= 24; i++) {
    const p = evalSeg(s, i / 24);
    len += dist(prev, p);
    prev = p;
  }
  return len;
}

export const segMid = (s: SketchSeg): SPoint => evalSeg(s, 0.5);

/* ---------------- ساخت المان‌ها ---------------- */

export function makeSeg(kind: SketchKind, pts: SPoint[]): SketchSeg | null {
  const id = newSegId();
  if (kind === "line" && pts.length >= 2) return { id, kind, a: pts[0], b: pts[1] };
  if (kind === "quad" && pts.length >= 3) return { id, kind, a: pts[0], b: pts[1], c1: pts[2] };
  if (kind === "cubic" && pts.length >= 4) return { id, kind, a: pts[0], b: pts[1], c1: pts[2], c2: pts[3] };
  if (kind === "arc" && pts.length >= 3) return { id, kind, a: pts[0], b: pts[1], via: pts[2] };
  return null;
}

/** دستهٔ پیش‌فرض برای منحنی درجه۳ بین دو نقطه */
export function defaultCubicHandles(a: SPoint, b: SPoint): [SPoint, SPoint] {
  return [
    { z: lerp(a.z, b.z, 1 / 3), r: lerp(a.r, b.r, 1 / 3) },
    { z: lerp(a.z, b.z, 2 / 3), r: lerp(a.r, b.r, 2 / 3) },
  ];
}

/* ---------------- کنترل دقیق هندسی ---------------- */

export const lineAngle = (a: SPoint, b: SPoint) => (Math.atan2(b.r - a.r, b.z - a.z) * 180) / Math.PI;

/** نقطهٔ پایان جدید بر اساس طول و زاویهٔ دقیق */
export function endFromLenAngle(a: SPoint, len: number, angDeg: number): SPoint {
  const rad = (angDeg * Math.PI) / 180;
  return { z: a.z + len * Math.cos(rad), r: a.r + len * Math.sin(rad) };
}

/** تنظیم شعاع کمان با جابه‌جایی نقطهٔ میانی روی عمودمنصف وتر */
export function arcWithRadius(s: SketchSeg, radius: number): SketchSeg {
  const { a, b } = s;
  const mz = (a.z + b.z) / 2;
  const mr = (a.r + b.r) / 2;
  const half = dist(a, b) / 2;
  if (half < 1e-6) return s;
  const R = Math.max(radius, half + 1e-4);
  const dz = (b.z - a.z) / (2 * half);
  const dr = (b.r - a.r) / (2 * half);
  const nz = -dr;
  const nr = dz;
  const info = arcInfo(s);
  let side = 1;
  if (info && s.via) {
    const cur = (s.via.z - mz) * nz + (s.via.r - mr) * nr;
    side = cur >= 0 ? 1 : -1;
  }
  const sag = R - Math.sqrt(Math.max(0, R * R - half * half));
  return { ...s, via: { z: mz + nz * sag * side, r: mr + nr * sag * side } };
}

export function arcRadius(s: SketchSeg): number {
  const info = arcInfo(s);
  return info ? info.radius : 0;
}

/* ---------------- جابه‌جایی و کپی ---------------- */

const movePt = (p: SPoint, dz: number, dr: number): SPoint => ({ z: p.z + dz, r: p.r + dr });

export function moveSeg(s: SketchSeg, dz: number, dr: number): SketchSeg {
  return {
    ...s,
    a: movePt(s.a, dz, dr),
    b: movePt(s.b, dz, dr),
    c1: s.c1 ? movePt(s.c1, dz, dr) : undefined,
    c2: s.c2 ? movePt(s.c2, dz, dr) : undefined,
    via: s.via ? movePt(s.via, dz, dr) : undefined,
  };
}

export function cloneSeg(s: SketchSeg, dz = 0, dr = 0): SketchSeg {
  return { ...moveSeg(s, dz, dr), id: newSegId() };
}

/* ---------------- اسنپ هوشمند ---------------- */

export type SnapType = "end" | "mid" | "center" | "ctrl" | "cross" | "axis" | "grid";

export interface SnapPoint {
  p: SPoint;
  type: SnapType;
  segId?: number;
}

export const SNAP_FA: Record<SnapType, string> = {
  end: "نقطهٔ انتها",
  mid: "وسط",
  center: "مرکز کمان",
  ctrl: "نقطهٔ کنترل",
  cross: "تقاطع",
  axis: "محور",
  grid: "شبکه",
};

/** نقاط مهم هندسی برای چسبندگی (به‌جز شبکه که پویا محاسبه می‌شود) */
export function snapCandidates(segs: SketchSeg[]): SnapPoint[] {
  const out: SnapPoint[] = [];
  for (const s of segs) {
    out.push({ p: s.a, type: "end", segId: s.id });
    out.push({ p: s.b, type: "end", segId: s.id });
    out.push({ p: segMid(s), type: "mid", segId: s.id });
    if (s.c1) out.push({ p: s.c1, type: "ctrl", segId: s.id });
    if (s.c2) out.push({ p: s.c2, type: "ctrl", segId: s.id });
    if (s.kind === "arc") {
      const info = arcInfo(s);
      if (info) out.push({ p: info.center, type: "center", segId: s.id });
      if (s.via) out.push({ p: s.via, type: "ctrl", segId: s.id });
    }
  }
  return out;
}

function segIntersect(p1: SPoint, p2: SPoint, p3: SPoint, p4: SPoint): SPoint | null {
  const d = (p2.z - p1.z) * (p4.r - p3.r) - (p2.r - p1.r) * (p4.z - p3.z);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3.z - p1.z) * (p4.r - p3.r) - (p3.r - p1.r) * (p4.z - p3.z)) / d;
  const u = ((p3.z - p1.z) * (p2.r - p1.r) - (p3.r - p1.r) * (p2.z - p1.z)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { z: p1.z + t * (p2.z - p1.z), r: p1.r + t * (p2.r - p1.r) };
}

/** نقاط تقاطع بین المان‌ها (روی چندضلعی تقریبی) */
export function intersectionPoints(segs: SketchSeg[]): SnapPoint[] {
  const polys = segs.map((s) => segPoints(s, s.kind === "line" ? 1 : 26));
  const out: SnapPoint[] = [];
  for (let i = 0; i < polys.length && out.length < 60; i++) {
    for (let j = i + 1; j < polys.length && out.length < 60; j++) {
      const A = polys[i];
      const B = polys[j];
      for (let x = 0; x < A.length - 1; x++) {
        for (let y = 0; y < B.length - 1; y++) {
          const hit = segIntersect(A[x], A[x + 1], B[y], B[y + 1]);
          if (hit && !out.some((o) => dist(o.p, hit) < 0.4)) out.push({ p: hit, type: "cross" });
        }
      }
    }
  }
  return out;
}

/* ---------------- نزدیک‌ترین نقطه روی المان (برای انتخاب) ---------------- */

export function distToSeg(s: SketchSeg, p: SPoint): number {
  const pts = segPoints(s, s.kind === "line" ? 1 : 40);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dz = b.z - a.z;
    const dr = b.r - a.r;
    const L2 = dz * dz + dr * dr;
    let t = L2 > 1e-12 ? ((p.z - a.z) * dz + (p.r - a.r) * dr) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.z - (a.z + t * dz), p.r - (a.r + t * dr));
    if (d < best) best = d;
  }
  return best;
}

/* ---------------- تبدیل به پروفایل موتور تراش ---------------- */

let ppUid = 90000;

/**
 * تخت‌سازی اسکچ به نقاط پروفایل: همهٔ المان‌ها نمونه‌برداری، بر اساس z مرتب و
 * در z های یکسان بیشترین شعاع (پوشش بیرونی) انتخاب می‌شود تا پروفایل تراش
 * همیشه معتبر و بدون زیربرش باشد.
 */
export function flattenSketch(segs: SketchSeg[], blankR: number, blankL: number): PPoint[] {
  const raw: SPoint[] = [];
  for (const s of segs) {
    const pts = s.kind === "line" ? [s.a, s.b] : segPoints(s);
    for (const p of pts) {
      if (!Number.isFinite(p.z) || !Number.isFinite(p.r)) continue;
      raw.push({ z: Math.min(blankL, Math.max(0, p.z)), r: Math.min(blankR, Math.max(0.2, p.r)) });
    }
  }
  if (raw.length < 2) return [];
  raw.sort((x, y) => x.z - y.z);
  const merged: SPoint[] = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.z - p.z) < 0.06) {
      if (p.r > last.r) last.r = p.r;
    } else {
      merged.push({ ...p });
    }
  }
  if (merged.length < 2) return [];
  return merged.map((p) => ({ id: ++ppUid, z: p.z, r: p.r, smooth: false }));
}

/**
 * ساخت اسکچ از نقاط قدیمی: بازه‌های «صاف» به منحنی درجه۳ معادل کاتمول‑رام
 * (دقیقاً همان شکل قبلی) و بقیه به خط تبدیل می‌شوند.
 */
export function sketchFromPoints(pts: { z: number; r: number; smooth: boolean }[]): SketchSeg[] {
  const p = [...pts].sort((x, y) => x.z - y.z);
  const out: SketchSeg[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[Math.min(p.length - 1, i + 2)];
    if (p1.smooth && p2.smooth) {
      out.push({
        id: newSegId(),
        kind: "cubic",
        a: { z: p1.z, r: p1.r },
        b: { z: p2.z, r: p2.r },
        c1: { z: p1.z + (p2.z - p0.z) / 6, r: p1.r + (p2.r - p0.r) / 6 },
        c2: { z: p2.z - (p3.z - p1.z) / 6, r: p2.r - (p3.r - p1.r) / 6 },
      });
    } else {
      out.push({ id: newSegId(), kind: "line", a: { z: p1.z, r: p1.r }, b: { z: p2.z, r: p2.r } });
    }
  }
  return out;
}

/** اعتبارسنجی داده‌های ذخیره‌شده */
export function normalizeSketch(raw: unknown): SketchSeg[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ok = (v: unknown): v is SPoint =>
    !!v && typeof (v as SPoint).z === "number" && typeof (v as SPoint).r === "number" &&
    Number.isFinite((v as SPoint).z) && Number.isFinite((v as SPoint).r);
  const out: SketchSeg[] = [];
  for (const s of raw as SketchSeg[]) {
    if (!s || !ok(s.a) || !ok(s.b)) continue;
    if (s.kind !== "line" && s.kind !== "quad" && s.kind !== "cubic" && s.kind !== "arc") continue;
    if (s.kind === "quad" && !ok(s.c1)) continue;
    if (s.kind === "cubic" && (!ok(s.c1) || !ok(s.c2))) continue;
    if (s.kind === "arc" && !ok(s.via)) continue;
    out.push({
      id: typeof s.id === "number" ? s.id : newSegId(),
      kind: s.kind,
      a: { z: s.a.z, r: s.a.r },
      b: { z: s.b.z, r: s.b.r },
      c1: s.c1 ? { z: s.c1.z, r: s.c1.r } : undefined,
      c2: s.c2 ? { z: s.c2.z, r: s.c2.r } : undefined,
      via: s.via ? { z: s.via.z, r: s.via.r } : undefined,
    });
  }
  for (const s of out) segUid = Math.max(segUid, s.id);
  return out.length ? out : null;
}
