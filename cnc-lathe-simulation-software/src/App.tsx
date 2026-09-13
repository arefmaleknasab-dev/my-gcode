import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ControlsPanel from "./components/ControlsPanel";
import GCodePanel from "./components/GCodePanel";
import ProfileEditor, { type EdSettings } from "./components/ProfileEditor";
import SimulationView from "./components/SimulationView";
import { IconCheck, IconDownload, IconLayers, IconPen, IconRedo, IconSim, IconSpindle, IconUndo, IconWarn } from "./components/icons";
import { buildDxf } from "./lib/dxf";
import { PRESETS, STRATEGIES, generate, makeOps, normalizeParams, presetPoints } from "./lib/lathe";
import type { Params, PPoint, Preset } from "./lib/lathe";
import type { SketchSeg } from "./lib/sketch";
import { autoSplitPoint, branchPoints, chainPolyline, flattenSketch, normalizeSketch, orderChain, sketchFromPoints, sketchFromWall, splitChainAt } from "./lib/sketch";
import { cn } from "./utils/cn";

const STORE_KEY = "kharraatcode-v1";

interface Saved {
  points?: PPoint[];
  sketch?: SketchSeg[];
  params?: Partial<Params>;
  settings?: Partial<EdSettings>;
  activePreset?: string | null;
  version?: number;
}

const SAVE_VERSION = 4;

let SAVED: Saved | null = null;
try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) SAVED = JSON.parse(raw) as Saved;
} catch {
  SAVED = null;
}

/* داده‌های پیش از نسخه ۲: عملیات «spring» و «offset» معنای متفاوتی داشتند */
const IS_LEGACY = !SAVED || !SAVED.version || SAVED.version < 3;

export default function App() {
  const [sketch, setSketch] = useState<SketchSeg[]>(() => {
    const fromSaved = normalizeSketch(SAVED?.sketch);
    if (fromSaved) return fromSaved;
    if (SAVED?.points && SAVED.points.length >= 2) return sketchFromPoints(SAVED.points);
    return sketchFromPoints(presetPoints(PRESETS[0]));
  });
  const [params, setParams] = useState<Params>(() => normalizeParams(SAVED?.params, IS_LEGACY));
  const [settings, setSettings] = useState<EdSettings>(() => {
    const s = SAVED?.settings;
    return {
      snap: s?.snap ?? 1,
      smartSnap: s?.smartSnap ?? true,
      showRough: s?.showRough ?? true,
      showFinish: s?.showFinish ?? true,
      showOffset: s?.showOffset ?? true,
      showBore: s?.showBore ?? true,
      showRound: s?.showRound ?? true,
      showFace: s?.showFace ?? true,
      showRapids: s?.showRapids ?? true,
      showGhost: s?.showGhost ?? true,
    };
  });
  const [mode, setMode] = useState<"design" | "sim">("design");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>(SAVED?.activePreset ?? PRESETS[0].id);
  const [activeLine, setActiveLine] = useState(-1);
  const [isolatedOpId, setIsolatedOpId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "warn" } | null>(null);
  const [, setHistVer] = useState(0);

  const past = useRef<SketchSeg[][]>([]);
  const future = useRef<SketchSeg[][]>([]);
  const toastTimer = useRef<number | null>(null);

  /* پروفایل نقطه‌ای برای موتور تراش — حالت عادی تخت، حالت کاسه دوشاخه (Split) */
  const { points, innerPoints, splitInfo } = useMemo(() => {
    const blankR = params.blankD / 2;
    if (params.split.enabled) {
      const poly = chainPolyline(orderChain(sketch));
      if (poly.length >= 3) {
        const sp = splitChainAt(poly, { z: params.split.z, r: params.split.r });
        return {
          points: branchPoints(sp.outer, blankR, params.blankL, "max"),
          innerPoints: branchPoints(sp.inner, blankR, params.blankL, "min"),
          splitInfo: { outerDir: sp.outerDir, innerDir: sp.innerDir, at: sp.splitAt },
        };
      }
    }
    const none: { outerDir: 1 | -1; innerDir: 1 | -1; at: { z: number; r: number } } | null = null;
    return { points: flattenSketch(sketch, blankR, params.blankL), innerPoints: [] as PPoint[], splitInfo: none };
  }, [sketch, params.split, params.blankD, params.blankL]);

  const gen = useMemo(() => generate(points, params, innerPoints), [points, params, innerPoints]);

  /* ذخیره محلی */
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sketch, params, settings, activePreset, version: SAVE_VERSION }));
    } catch {
      /* ignore */
    }
  }, [sketch, params, settings, activePreset]);

  /* هنگام تغییر برنامه، هایلایت جی‌کد پاک شود */
  useEffect(() => {
    setActiveLine(-1);
  }, [gen]);

  /* اگر عملیاتِ ایزوله‌شده حذف شد، از حالت ایزوله خارج شو */
  useEffect(() => {
    if (isolatedOpId != null && !params.ops.some((o) => o.id === isolatedOpId)) setIsolatedOpId(null);
  }, [params.ops, isolatedOpId]);

  /* واگرد / بازانجام روی اسکچ */
  const commitRef = useRef<SketchSeg[] | null>(null);
  const undo = () => {
    if (past.current.length === 0) return;
    future.current.push(sketch);
    commitRef.current = null;
    setSketch(past.current.pop()!);
    setHistVer((v) => v + 1);
  };
  const redo = () => {
    if (future.current.length === 0) return;
    past.current.push(sketch);
    setSketch(future.current.pop()!);
    setHistVer((v) => v + 1);
  };

  const showToast = useCallback((msg: string, kind: "ok" | "warn" = "ok") => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  /* کال‌بک‌های پایدار: هویت ثابت تا فرزندهای memo هنگام تیک شبیه‌سازی بازرندر نشوند */
  const onParamsCb = useCallback((patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch })), []);
  const onStrategyCb = useCallback((name: string) => showToast(`استراتژی «${name}» فعال شد`), [showToast]);

  /* تغییر اسکچ — با commit=false تغییر زنده (کشیدن) و با true ثبت در تاریخچه */
  const onSketchChange = useCallback((next: SketchSeg[], commit: boolean) => {
    if (commit) {
      past.current.push(commitRef.current ?? sketch);
      commitRef.current = null;
      future.current = [];
      if (past.current.length > 80) past.current.shift();
      setActivePreset(null);
    } else if (!commitRef.current) {
      commitRef.current = sketch; // وضعیت پیش از شروع کشیدن
    }
    setSketch(next);
    setHistVer((v) => v + 1);
  }, [sketch]);

  const applyPreset = useCallback((p: Preset) => {
    if (p.wall) {
      /* کاسه: دیواره به ترتیب مسیر (خارج ← لبه ← داخل) ساخته می‌شود */
      onSketchChange(
        sketchFromWall(p.wall.map(([z, r, smooth]) => ({ z, r, smooth }))),
        true
      );
    } else {
      onSketchChange(sketchFromPoints(presetPoints(p)), true);
    }
    setParams((prev) => {
      const next: Params = { ...prev, blankD: p.blankD, blankL: p.blankL };
      if (p.shape) next.blankShape = p.shape;
      next.split = p.split
        ? { enabled: true, z: p.split.z, r: p.split.r }
        : { ...prev.split, enabled: false };
      if (p.strategy) {
        const st = STRATEGIES.find((s) => s.id === p.strategy);
        if (st) next.ops = makeOps(st.types);
      }
      return next;
    });
    setActivePreset(p.id);
    setSelectedIds([]);
    showToast(
      p.strategy === "bowl"
        ? `پیش‌تنظیم «${p.name}» + استراتژی داخل/خارج فعال شد`
        : `پیش‌تنظیم «${p.name}» اعمال شد`
    );
  }, [onSketchChange, showToast]);

  /* قرار دادن خودکار نقطه Split روی لبه (بیشترین X زنجیره) */
  const autoSplit = useCallback(() => {
    const poly = chainPolyline(orderChain(sketch));
    const auto = autoSplitPoint(poly);
    if (auto) {
      setParams((prev) => ({ ...prev, split: { ...prev.split, enabled: true, z: auto.z, r: auto.r } }));
      showToast(`نقطه Split روی لبه قرار گرفت (X ${auto.z} • ⌀ ${(auto.r * 2).toFixed(1)})`);
    } else {
      showToast("زنجیره پروفیل برای Split خودکار کافی نیست", "warn");
    }
  }, [sketch, showToast]);

  const copyGCode = async () => {
    const text = gen.lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast("جی‌کد در کلیپ‌بورد کپی شد");
    } catch {
      showToast("کپی ممکن نشد — فایل را دانلود کنید", "warn");
    }
  };
  const downloadGCode = () => {
    const blob = new Blob([gen.lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kharraatcode.nc";
    a.click();
    URL.revokeObjectURL(url);
    showToast("فایل kharraatcode.nc آماده شد");
  };

  const downloadDxf = () => {
    const { text, vertexCount, opCount } = buildDxf(gen.segs, params.ops, params.blankL, params.blankD / 2);
    const blob = new Blob([text], { type: "application/dxf;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kharraatcode-cutpath.dxf";
    a.click();
    URL.revokeObjectURL(url);
    showToast(`مسیر برشی ${opCount.toLocaleString("fa-IR")} عملیات با ${vertexCount.toLocaleString("fa-IR")} نقطه به DXF تبدیل شد`);
  };

  return (
    <div className="flex h-full flex-col">
      {/* ---------- سربرگ ---------- */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-panel/85 px-3.5 py-2 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-brass/40 bg-gradient-to-b from-panel3 to-panel text-brass shadow-[0_0_18px_rgba(227,169,78,0.18)]">
            <IconSpindle className="h-5 w-5" />
          </span>
          <div className="leading-none">
            <h1 className="font-display text-[22px] leading-6 text-brass2">خراط‌کد</h1>
            <p className="mt-0.5 text-[10px] font-medium text-mute">شبیه‌ساز و جی‌کدساز خراطی دومحور CNC</p>
          </div>
        </div>

        {/* تب‌ها */}
        <nav className="mx-auto flex rounded-lg border border-edge bg-panel2 p-0.5">
          <TabBtn on={mode === "design"} onClick={() => setMode("design")} icon={<IconPen className="h-3.5 w-3.5" />} label="طراحی پروفایل" />
          <TabBtn on={mode === "sim"} onClick={() => setMode("sim")} icon={<IconSim className="h-3.5 w-3.5" />} label="شبیه‌سازی تراش" />
        </nav>

        <div className="flex items-center gap-1.5">
          <button className="btn !px-2 !py-1.5" onClick={undo} disabled={past.current.length === 0} title="واگرد (Ctrl+Z)">
            <IconUndo className="h-4 w-4" />
          </button>
          <button className="btn !px-2 !py-1.5" onClick={redo} disabled={future.current.length === 0} title="بازانجام (Ctrl+Y)">
            <IconRedo className="h-4 w-4" />
          </button>
          <span className="mx-1 h-5 w-px bg-edge" />
          <button
            className="btn btn-teal !px-2.5 !py-1.5 text-[11.5px]"
            onClick={downloadDxf}
            title="فقط مسیر عملیات تراش به ترتیب استراتژی — یکپارچه + لایهٔ مجزا برای هر عملیات"
          >
            <IconLayers className="h-3.5 w-3.5" />
            خروجی DXF
          </button>
          <button className="btn !px-2.5 !py-1.5 text-[11.5px]" onClick={copyGCode}>
            کپی جی‌کد
          </button>
          <button className="btn btn-brass !px-2.5 !py-1.5 text-[11.5px]" onClick={downloadGCode}>
            <IconDownload className="h-3.5 w-3.5" />
            دانلود NC
          </button>
        </div>
      </header>

      {/* ---------- بدنه ---------- */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
        <aside className="order-2 w-full shrink-0 lg:order-1 lg:w-[272px]">
          <ControlsPanel
            params={params}
            onParams={onParamsCb}
            points={points}
            innerPoints={innerPoints}
            splitInfo={splitInfo}
            onAutoSplit={autoSplit}
            activePreset={activePreset}
            onApplyPreset={applyPreset}
            onStrategy={onStrategyCb}
            isolatedOpId={isolatedOpId}
            onIsolate={setIsolatedOpId}
            onNotify={showToast}
          />
        </aside>

        <main className="order-1 h-[54vh] min-w-0 flex-1 lg:order-2 lg:h-auto">
          {mode === "design" ? (
            <ProfileEditor
              segs={sketch}
              onSegs={onSketchChange}
              selected={selectedIds}
              onSelected={setSelectedIds}
              params={params}
              gen={gen}
              split={params.split}
              onSplit={(s) => setParams((p) => ({ ...p, split: s }))}
              settings={settings}
              onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
              ops={params.ops}
              isolatedOpId={isolatedOpId}
              onClearIsolate={() => setIsolatedOpId(null)}
              onUndo={undo}
              onRedo={redo}
              canUndo={past.current.length > 0}
              canRedo={future.current.length > 0}
            />
          ) : (
            <SimulationView gen={gen} params={params} onActiveLine={setActiveLine} />
          )}
        </main>

        <aside className="order-3 h-[420px] w-full shrink-0 lg:h-auto lg:w-[330px]">
          <GCodePanel
            gen={gen}
            activeLine={activeLine}
            onCopy={copyGCode}
            onDownload={downloadGCode}
            badge={
              params.split.enabled
                ? `کاسه • Split (X ${params.split.z} / ⌀ ${(params.split.r * 2).toFixed(1)}) • H2 (X ${params.holder2.xOff} / Y ${params.holder2.yOff})`
                : undefined
            }
          />
        </aside>
      </div>

      {/* ---------- توست ---------- */}
      {toast && (
        <div
          key={toast.msg}
          className={cn(
            "toast-anim fixed bottom-5 left-1/2 z-50 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[12.5px] font-semibold shadow-xl shadow-black/50 backdrop-blur",
            toast.kind === "ok" ? "border-ok/40 bg-panel/95 text-ok" : "border-danger/40 bg-panel/95 text-danger"
          )}
          style={{ transform: "translate(-50%,0)" }}
        >
          {toast.kind === "ok" ? <IconCheck className="h-4 w-4" /> : <IconWarn className="h-4 w-4" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function TabBtn({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-bold transition-all",
        on ? "bg-brass text-[#241a0c] shadow-[0_2px_10px_rgba(227,169,78,0.35)]" : "text-mute hover:text-ink"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
