import { useState, useRef, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";
import { Play, Pause, RotateCcw, Thermometer, Zap, AlertTriangle, Activity, Gauge } from "lucide-react";

// ---------------------------------------------------------------------------
// PHYSICAL MODEL (simplified, tuned for a legible 5–10 min demo, not lab-grade
// accuracy — the point is to show the *shape* of the core/surface divergence
// and the controller's response, which is exactly what a judge needs to see)
// ---------------------------------------------------------------------------
const CELLS = 4;                 // 4S pack
const CAPACITY_AH = 3.0;
const VMAX_CELL = 4.2;
const R_INT = 0.16;              // ohm, lumped pack internal resistance
const C_CORE = 42;               // J/°C thermal mass, core
const C_SURF = 34;               // J/°C thermal mass, surface shell
const K_CS = 1.05;               // W/°C core <-> surface coupling
const K_SA = 1.55;               // W/°C surface <-> ambient coupling
const T_HIGH = 52;                // °C twin trip threshold
const T_LOW = 49;                 // °C hysteresis reset
const PULSE_PERIOD_S = 6;         // seconds per on/off half-cycle in pulsed mode
const PULSE_DUTY_LOW_FRAC = 0.12; // current fraction during pulse "off" phase

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function tempToColor(t) {
  // 25°C -> cyan, 48°C -> amber, 58°C+ -> red
  const stops = [
    { t: 25, c: [45, 212, 191] },
    { t: 40, c: [94, 234, 212] },
    { t: 48, c: [245, 158, 11] },
    { t: 55, c: [239, 68, 68] },
    { t: 62, c: [220, 38, 38] },
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; break; }
  }
  if (t <= stops[0].t) return `rgb(${stops[0].c.join(",")})`;
  if (t >= stops[stops.length - 1].t) return `rgb(${stops[stops.length - 1].c.join(",")})`;
  const f = (t - a.t) / (b.t - a.t || 1);
  const c = a.c.map((v, i) => Math.round(v + f * (b.c[i] - v)));
  return `rgb(${c.join(",")})`;
}

function freshState() {
  return {
    tCore: 30, tSurface: 29.5, soc: 0.15, vTerm: CELLS * 3.4,
    iActual: 0, phase: "CC", override: false, pulseOn: true,
    pulseClock: 0, simSec: 0, done: false,
  };
}

export default function BatteryDigitalTwin() {
  const [ambient, setAmbient] = useState(45);
  const [cRate, setCRate] = useState(1.5);
  const [speed, setSpeed] = useState(30);
  const [running, setRunning] = useState(false);
  const [snap, setSnap] = useState(freshState());
  const [chartData, setChartData] = useState([]);
  const [events, setEvents] = useState([
    { t: 0, msg: "Twin initialized. Waiting for charge start.", kind: "info" },
  ]);

  const stateRef = useRef(freshState());
  const ambRef = useRef(ambient);
  const crateRef = useRef(cRate);
  const speedRef = useRef(speed);
  const sampleAccRef = useRef(0);
  const intervalRef = useRef(null);

  useEffect(() => { ambRef.current = ambient; }, [ambient]);
  useEffect(() => { crateRef.current = cRate; }, [cRate]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  const pushEvent = useCallback((simSec, msg, kind) => {
    setEvents((prev) => [{ t: simSec, msg, kind }, ...prev].slice(0, 30));
  }, []);

  const step = useCallback((s, dt) => {
    const amb = ambRef.current;
    const targetI = crateRef.current * CAPACITY_AH;

    if (!s.done) {
      // --- twin decision: thermal override on commanded current ---
      if (!s.override && s.tCore > T_HIGH) {
        s.override = true;
        s.pulseClock = 0;
        s.pulseOn = false;
        pushEvent(s.simSec, `T_core crossed ${T_HIGH}°C — twin overrides CC-CV, switching to pulsed current`, "warn");
      } else if (s.override && s.tCore < T_LOW) {
        s.override = false;
        pushEvent(s.simSec, `T_core cooled below ${T_LOW}°C — resuming standard CC-CV`, "ok");
      }

      let iCmd;
      if (s.phase === "CV") {
        iCmd = Math.max(s.iActual * 0.995, 0.04 * targetI);
      } else {
        iCmd = targetI;
      }

      if (s.override) {
        s.pulseClock += dt;
        if (s.pulseClock >= PULSE_PERIOD_S) { s.pulseClock = 0; s.pulseOn = !s.pulseOn; }
        iCmd = s.pulseOn ? iCmd : iCmd * PULSE_DUTY_LOW_FRAC;
      }

      const qGen = iCmd * iCmd * R_INT;
      const dTcore = (qGen - K_CS * (s.tCore - s.tSurface)) / C_CORE * dt;
      const dTsurf = (K_CS * (s.tCore - s.tSurface) - K_SA * (s.tSurface - amb)) / C_SURF * dt;
      s.tCore = clamp(s.tCore + dTcore, amb - 2, 90);
      s.tSurface = clamp(s.tSurface + dTsurf, amb - 2, 90);

      s.soc = clamp(s.soc + (iCmd * dt) / (CAPACITY_AH * 3600), 0, 1);
      const ocvCell = 3.0 + 1.2 * s.soc;
      s.vTerm = ocvCell * CELLS + iCmd * R_INT;
      s.iActual = iCmd;

      if (s.phase === "CC" && s.vTerm >= VMAX_CELL * CELLS) {
        s.phase = "CV";
        pushEvent(s.simSec, "Pack reached CV threshold voltage — entering constant-voltage taper", "info");
      }
      if (s.soc >= 0.995 || (s.phase === "CV" && s.iActual < 0.05 * targetI)) {
        s.done = true;
        s.iActual = 0;
        pushEvent(s.simSec, "Charge complete — pack at target SoC", "ok");
      }
      s.simSec += dt;
    }
    return s;
  }, [pushEvent]);

  useEffect(() => {
    if (!running) { clearInterval(intervalRef.current); return; }
    intervalRef.current = setInterval(() => {
      const substeps = Math.max(1, Math.round(speedRef.current / 3));
      let s = stateRef.current;
      for (let i = 0; i < substeps; i++) {
        if (s.done) break;
        s = step(s, 1);
      }
      stateRef.current = s;
      sampleAccRef.current += substeps;
      setSnap({ ...s });
      if (sampleAccRef.current >= 4 || s.done) {
        sampleAccRef.current = 0;
        setChartData((prev) => {
          const next = [...prev, {
            t: Math.round(s.simSec),
            core: +s.tCore.toFixed(2),
            surface: +s.tSurface.toFixed(2),
            ambient: ambRef.current,
            current: +s.iActual.toFixed(2),
          }];
          return next.length > 260 ? next.slice(next.length - 260) : next;
        });
      }
      if (s.done) setRunning(false);
    }, 150);
    return () => clearInterval(intervalRef.current);
  }, [running, step]);

  const handleReset = () => {
    setRunning(false);
    const fresh = freshState();
    stateRef.current = fresh;
    setSnap(fresh);
    setChartData([]);
    sampleAccRef.current = 0;
    setEvents([{ t: 0, msg: "Twin reset. Waiting for charge start.", kind: "info" }]);
  };

  const deltaT = snap.tCore - snap.tSurface;
  const modeLabel = snap.done ? "CHARGE COMPLETE" : snap.override ? "PULSED COOLING OVERRIDE" : `${snap.phase} CHARGING`;
  const modeColor = snap.done ? "#5EEAD4" : snap.override ? "#F59E0B" : "#22D3EE";
  const riskHigh = snap.tCore > T_HIGH;

  return (
    <div style={{ fontFamily: "Inter, ui-sans-serif, system-ui", background: "#0A0E0D" }}
      className="w-full min-h-screen text-slate-200 p-4 md:p-6">
      <style>{`
        @keyframes pulseRing { 0%{ transform:scale(1); opacity:.55 } 70%{ transform:scale(1.55); opacity:0 } 100%{ opacity:0 } }
        .ring-pulse { animation: pulseRing 1.4s ease-out infinite; }
        .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; }
        .grid-bg {
          background-image: linear-gradient(rgba(94,234,212,0.05) 1px, transparent 1px),
                             linear-gradient(90deg, rgba(94,234,212,0.05) 1px, transparent 1px);
          background-size: 26px 26px;
        }
        input[type=range] { accent-color: #5EEAD4; }
      `}</style>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5 border-b border-white/10 pb-4">
        <div>
          <div className="text-xs tracking-[0.25em] text-teal-300/70 mono mb-1">SIH · OPTION 1 SIMULATION</div>
          <h1 className="text-xl md:text-2xl font-semibold text-white">
            Thermal Runaway &amp; Li‑Plating Guard — Battery Digital Twin
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            No physical rig needed — this runs the core/surface thermal &amp; charge model in-browser and drives the
            same pulsed-current override logic your ESP32 firmware would.
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5">
          <span className="w-2 h-2 rounded-full" style={{ background: modeColor, boxShadow: `0 0 8px ${modeColor}` }} />
          <span className="mono text-xs tracking-wide" style={{ color: modeColor }}>{modeLabel}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* Controls column */}
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Gauge size={13} /> Conditions
            </div>
            <label className="text-xs text-slate-400">Ambient temperature</label>
            <div className="flex items-center justify-between mb-1">
              <span className="mono text-lg text-white">{ambient}°C</span>
              <span className="text-[10px] text-slate-500">Indian summer 40–48°C</span>
            </div>
            <input type="range" min={28} max={48} value={ambient} disabled={running}
              onChange={(e) => setAmbient(+e.target.value)} className="w-full mb-4" />

            <label className="text-xs text-slate-400">Fast-charge rate</label>
            <div className="flex items-center justify-between mb-1">
              <span className="mono text-lg text-white">{cRate.toFixed(1)}C</span>
              <span className="text-[10px] text-slate-500">{(cRate * CAPACITY_AH).toFixed(1)} A cmd</span>
            </div>
            <input type="range" min={0.5} max={3} step={0.1} value={cRate} disabled={running}
              onChange={(e) => setCRate(+e.target.value)} className="w-full mb-4" />

            <label className="text-xs text-slate-400">Simulation speed</label>
            <div className="flex items-center justify-between mb-1">
              <span className="mono text-lg text-white">{speed}×</span>
            </div>
            <input type="range" min={5} max={60} step={5} value={speed}
              onChange={(e) => setSpeed(+e.target.value)} className="w-full mb-4" />

            <div className="flex gap-2 mt-2">
              <button onClick={() => setRunning((r) => !r)} disabled={snap.done}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium bg-teal-400/90 text-black disabled:opacity-40 hover:bg-teal-300 transition">
                {running ? <Pause size={14} /> : <Play size={14} />} {running ? "Pause" : "Start"}
              </button>
              <button onClick={handleReset}
                className="flex items-center justify-center gap-1.5 rounded-lg py-2 px-3 text-sm bg-white/5 border border-white/10 hover:bg-white/10 transition">
                <RotateCcw size={14} />
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-3">Model, briefly</div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Two lumped thermal masses (core, surface) coupled to each other and to ambient, driven by I²R
              joule heating from a CC‑CV charge profile. Only <span className="text-slate-300">T_surface</span> would
              be visible to a normal BMS thermistor — <span className="text-slate-300">T_core</span> is the twin's estimate.
              When T_core &gt; {T_HIGH}°C the controller switches the commanded current to a
              {" "}{PULSE_PERIOD_S}s on/off pulse instead of tripping a hard cutoff.
            </p>
          </div>
        </div>

        {/* Main column */}
        <div className="space-y-5">
          {/* Cell visual + readouts */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-5 items-center grid-bg">
            <div className="flex justify-center">
              <div className="relative w-36 h-36">
                {snap.override && <div className="absolute inset-0 rounded-full ring-pulse" style={{ border: `2px solid ${tempToColor(snap.tCore)}` }} />}
                <svg viewBox="0 0 140 140" className="w-full h-full">
                  <circle cx="70" cy="70" r="64" fill={tempToColor(snap.tSurface)} opacity="0.18" />
                  <circle cx="70" cy="70" r="64" fill="none" stroke={tempToColor(snap.tSurface)} strokeWidth="1.5" opacity="0.6" />
                  <circle cx="70" cy="70" r="36" fill={tempToColor(snap.tCore)} opacity="0.9" />
                  <circle cx="70" cy="70" r="36" fill="none" stroke="white" strokeOpacity="0.25" strokeWidth="1" />
                  <text x="70" y="66" textAnchor="middle" className="mono" fontSize="15" fill="#0A0E0D" fontWeight="700">
                    {snap.tCore.toFixed(1)}
                  </text>
                  <text x="70" y="80" textAnchor="middle" className="mono" fontSize="7" fill="#0A0E0D">CORE °C</text>
                </svg>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Readout icon={<Thermometer size={13} />} label="Surface (sensed)" value={`${snap.tSurface.toFixed(1)}°C`} color="#5EEAD4" />
              <Readout icon={<Thermometer size={13} />} label="Core (twin est.)" value={`${snap.tCore.toFixed(1)}°C`} color={tempToColor(snap.tCore)} />
              <Readout icon={<Activity size={13} />} label="Hidden ΔT" value={`${deltaT >= 0 ? "+" : ""}${deltaT.toFixed(1)}°C`} color={deltaT > 3 ? "#F59E0B" : "#5EEAD4"} />
              <Readout icon={<Zap size={13} />} label="Current" value={`${snap.iActual.toFixed(2)} A`} color="#93C5FD" />
              <Readout icon={<Gauge size={13} />} label="Voltage" value={`${snap.vTerm.toFixed(2)} V`} color="#93C5FD" />
              <Readout icon={<Gauge size={13} />} label="SoC" value={`${(snap.soc * 100).toFixed(0)}%`} color="#A78BFA" />
              <Readout icon={<AlertTriangle size={13} />} label="Plating risk" value={riskHigh ? "ELEVATED" : "NOMINAL"} color={riskHigh ? "#EF4444" : "#5EEAD4"} />
              <Readout icon={<Activity size={13} />} label="Sim time" value={`${Math.floor(snap.simSec / 60)}m ${Math.round(snap.simSec % 60)}s`} color="#94A3B8" />
            </div>
          </div>

          {/* Temperature chart */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Core vs. surface temperature</div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 10, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#64748B" }} tickFormatter={(v) => `${v}s`} />
                  <YAxis tick={{ fontSize: 10, fill: "#64748B" }} domain={["dataMin - 2", "dataMax + 2"]} />
                  <Tooltip contentStyle={{ background: "#0F1512", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={T_HIGH} stroke="#F59E0B" strokeDasharray="4 4" label={{ value: "override", fontSize: 10, fill: "#F59E0B", position: "insideTopRight" }} />
                  <Line type="monotone" dataKey="core" name="T_core (twin)" stroke="#EF4444" dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line type="monotone" dataKey="surface" name="T_surface (sensed)" stroke="#5EEAD4" dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ambient" name="Ambient" stroke="#64748B" dot={false} strokeWidth={1} strokeDasharray="3 3" isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Current chart */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Charge current — watch it pulse under override</div>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 10, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#64748B" }} tickFormatter={(v) => `${v}s`} />
                  <YAxis tick={{ fontSize: 10, fill: "#64748B" }} />
                  <Tooltip contentStyle={{ background: "#0F1512", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
                  <Line type="stepAfter" dataKey="current" name="Commanded current (A)" stroke="#F59E0B" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Event log */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Twin decision log</div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto mono text-[11px] pr-1">
              {events.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-slate-600 shrink-0">[{Math.floor(e.t / 60)}m{String(Math.round(e.t % 60)).padStart(2, "0")}s]</span>
                  <span style={{ color: e.kind === "warn" ? "#F59E0B" : e.kind === "ok" ? "#5EEAD4" : "#94A3B8" }}>{e.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Readout({ icon, label, value, color }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-1">
        <span style={{ color }}>{icon}</span> {label}
      </div>
      <div className="mono text-sm font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}
