import { useState, useReducer, useEffect, useRef, useCallback, useMemo } from "react";

// ─── CONSTANTS ───────────────────────────────────────────
const SEVERITY = { NOMINAL: 0, CAUTION: 1, WARNING: 2, CRITICAL: 3, EXHAUSTED: 4 };
const STATE_NAMES = ["NOMINAL", "CAUTION", "WARNING", "CRITICAL", "EXHAUSTED"];
const SHAPES = { 0: "●", 1: "▲", 2: "◆", 3: "■", 4: "⬡" };
const COLORS = {
  0: "#46f1c5", 1: "#F5A623", 2: "#FF6B35", 3: "#FF3B5C", 4: "#FF3B5C",
};
const GLOW = {
  0: "0 0 10px rgba(70,241,197,0.4)",
  1: "0 0 10px rgba(245,166,35,0.4)",
  2: "0 0 10px rgba(255,107,53,0.4)",
  3: "0 0 10px rgba(255,59,92,0.4)",
  4: "0 0 14px rgba(255,59,92,0.6)",
};
const BURN_THRESHOLDS = { CAUTION: 2, WARNING: 5, CRITICAL: 10 };
const SLO_TARGET = 99.9;
const TOTAL_BUDGET_MIN = 43.2;
const BUFFER_SIZE = 20;
const CHART_WINDOW = 120;

const STATUS_MSGS = {
  0: "All SLOs within budget. No action required.",
  1: "Burn rate elevated. Deployment annotated — CI/CD gated.",
  2: "Error budget depleting. Replicas scaled 3 → 5.",
  3: "Budget near exhaustion. PagerDuty alert triggered.",
  4: "Error budget depleted. All deployments frozen.",
};

// ─── SIMULATION REDUCER ──────────────────────────────────
function initState() {
  return {
    tick: 0,
    errorRate: 1,
    rawBurnRate: 1,
    dampenedBurnRate: 1,
    errorBudgetPct: 100,
    operatorState: SEVERITY.NOMINAL,
    prevOperatorState: SEVERITY.NOMINAL,
    replicaCount: 3,
    podCount: 3,
    podMax: 3,
    prometheusOnline: true,
    flappingEnabled: false,
    cooldownRemaining: 0,
    incidentActive: false,
    incidentStartTick: null,
    firstActionTick: null,
    recoveryTick: null,
    timelineEvents: [{ tick: 0, severity: 0, shape: "●", msg: "SLO Guardian initialized. Watching api-server. SLO: 99.9%." }],
    incidentLog: [],
    burnBuffer: new Array(BUFFER_SIZE).fill(1),
    burnHistory: [{ tick: 0, raw: 1, dampened: 1 }],
    sliderErrorRate: 1,
    flappingPhase: 0,
    exhaustionDismissed: false,
    showPostMortem: false,
    podKillArmed: false,
    overrideArmed: false,
    overrideProgress: 0,
    activePreset: null,
    presetStep: 0,
    showHint: true,
  };
}

function reducer(s, action) {
  switch (action.type) {
    case "SET_ERROR_RATE": return { ...s, sliderErrorRate: action.value, activePreset: null, showHint: false };
    case "TOGGLE_PROMETHEUS": return { ...s, prometheusOnline: !s.prometheusOnline, showHint: false };
    case "TOGGLE_FLAPPING": return { ...s, flappingEnabled: !s.flappingEnabled, showHint: false };
    case "ARM_POD_KILL": return { ...s, podKillArmed: !s.podKillArmed };
    case "KILL_PODS": {
      if (!s.podKillArmed) return s;
      const newPods = Math.max(1, s.podCount - 2);
      const evt = { tick: s.tick, severity: 3, shape: "■", msg: `Pods killed. ${newPods}/${s.podMax} healthy.` };
      return { ...s, podCount: newPods, podKillArmed: false, timelineEvents: [...s.timelineEvents, evt], incidentActive: true, incidentStartTick: s.incidentStartTick ?? s.tick };
    }
    case "SHOW_POST_MORTEM": return { ...s, showPostMortem: true };
    case "HIDE_POST_MORTEM": return { ...s, showPostMortem: false };
    case "DISMISS_EXHAUSTION": return { ...s, exhaustionDismissed: true };
    case "ARM_OVERRIDE": return { ...s, overrideArmed: !s.overrideArmed };
    case "OVERRIDE_PROGRESS": return { ...s, overrideProgress: action.value };
    case "MANUAL_OVERRIDE": {
      const evt = { tick: s.tick, severity: 1, shape: "▲", msg: "Manual override. Budget seeded to 5%. Deployments unblocked." };
      return { ...s, errorBudgetPct: 5, operatorState: SEVERITY.CRITICAL, exhaustionDismissed: true, overrideArmed: false, overrideProgress: 0, timelineEvents: [...s.timelineEvents, evt] };
    }
    case "START_PRESET": return { ...s, activePreset: action.preset, presetStep: 0, showHint: false };
    case "STOP_PRESET": return { ...s, activePreset: null, presetStep: 0 };
    case "RESET": return initState();
    case "TICK": return tickReducer(s);
    default: return s;
  }
}

function tickReducer(s) {
  const n = { ...s, tick: s.tick + 1 };

  // Pod recovery
  if (n.podCount < n.podMax && n.tick % 5 === 0) n.podCount = Math.min(n.podMax, n.podCount + 1);

  // Preset automation
  if (n.activePreset) {
    n.presetStep = s.presetStep + 1;
    if (n.activePreset === "SLOW_BURN") {
      if (n.presetStep <= 60) n.sliderErrorRate = 1 + (29 * n.presetStep / 60);
      else if (n.presetStep <= 100) n.sliderErrorRate = 30 - (29 * (n.presetStep - 60) / 40);
      else { n.activePreset = null; n.sliderErrorRate = 1; }
    } else if (n.activePreset === "SUDDEN_SPIKE") {
      if (n.presetStep <= 1) n.sliderErrorRate = 80;
      else if (n.presetStep <= 8) n.sliderErrorRate = 80;
      else if (n.presetStep <= 12) n.sliderErrorRate = 40;
      else if (n.presetStep <= 18) n.sliderErrorRate = 10;
      else if (n.presetStep <= 22) n.sliderErrorRate = 1;
      else { n.activePreset = null; n.sliderErrorRate = 1; }
    } else if (n.activePreset === "CASCADE") {
      if (n.presetStep === 2) { n.podCount = 1; n.timelineEvents = [...s.timelineEvents, { tick: n.tick, severity: 3, shape: "■", msg: `Pods killed. 1/${n.podMax} healthy.` }]; }
      else if (n.presetStep === 6) n.sliderErrorRate = 60;
      else if (n.presetStep === 18) n.prometheusOnline = false;
      else if (n.presetStep === 28) n.prometheusOnline = true;
      else if (n.presetStep === 32) n.sliderErrorRate = 1;
      else if (n.presetStep > 55) { n.activePreset = null; }
    } else if (n.activePreset === "FLAP_STORM") {
      if (n.presetStep === 1) n.flappingEnabled = true;
      else if (n.presetStep === 35) { n.flappingEnabled = false; n.activePreset = null; }
    }
  }

  // Flapping oscillation
  if (n.flappingEnabled) {
    n.flappingPhase = (s.flappingPhase + 1) % 6;
    n.errorRate = n.flappingPhase < 3 ? 5 : 40;
  } else {
    n.errorRate = n.sliderErrorRate;
  }

  // Prometheus offline
  if (!n.prometheusOnline) {
    n.burnHistory = [...s.burnHistory.slice(-(CHART_WINDOW - 1)), { tick: n.tick, raw: null, dampened: null }];
    if (s.prometheusOnline) {
      n.timelineEvents = [...s.timelineEvents, { tick: n.tick, severity: 3, shape: "■", msg: "Prometheus unreachable. Reconciliation skipped." }];
    }
    return n;
  }

  // Burn rate calculation (simulation-tuned: 1%→1x, 15%→4x, 30%→7x, 50%→11x, 80%→17x)
  n.rawBurnRate = Math.max(0.1, 1 + (n.errorRate / 5));

  // Dampening buffer
  const buf = [...s.burnBuffer];
  buf.shift();
  buf.push(n.rawBurnRate);
  n.burnBuffer = buf;
  n.dampenedBurnRate = buf.reduce((a, b) => a + b, 0) / buf.length;

  // Budget drain/refill (tuned for 30-60s depletion at WARNING/CRITICAL)
  const drainPerTick = n.rawBurnRate > 1.2 ? (n.rawBurnRate - 1) * 0.3 : -0.05;
  n.errorBudgetPct = Math.max(0, Math.min(100, s.errorBudgetPct - drainPerTick));

  // History
  n.burnHistory = [...s.burnHistory.slice(-(CHART_WINDOW - 1)), { tick: n.tick, raw: n.rawBurnRate, dampened: n.dampenedBurnRate }];

  // Exhaustion check
  if (n.errorBudgetPct <= 0 && s.operatorState !== SEVERITY.EXHAUSTED) {
    n.operatorState = SEVERITY.EXHAUSTED;
    n.exhaustionDismissed = false;
    n.timelineEvents = [...s.timelineEvents, { tick: n.tick, severity: 4, shape: "⬡", msg: "Error budget depleted. CI/CD frozen." }];
    n.incidentLog = [...s.incidentLog, { tick: n.tick, type: "EXHAUSTED" }];
    return n;
  }
  if (s.operatorState === SEVERITY.EXHAUSTED && n.errorBudgetPct <= 0) return n;
  if (s.operatorState === SEVERITY.EXHAUSTED && n.errorBudgetPct > 0) {
    n.operatorState = SEVERITY.CRITICAL;
    n.timelineEvents = [...s.timelineEvents, { tick: n.tick, severity: 3, shape: "■", msg: "Budget recovering. Resuming operator actions." }];
  }

  // Cooldown
  if (s.cooldownRemaining > 0) {
    n.cooldownRemaining = s.cooldownRemaining - 1;
    return n;
  }

  // State transitions
  const db = n.dampenedBurnRate;
  let newState;
  if (db < BURN_THRESHOLDS.CAUTION) newState = SEVERITY.NOMINAL;
  else if (db < BURN_THRESHOLDS.WARNING) newState = SEVERITY.CAUTION;
  else if (db < BURN_THRESHOLDS.CRITICAL) newState = SEVERITY.WARNING;
  else newState = SEVERITY.CRITICAL;

  n.prevOperatorState = s.operatorState;
  if (newState !== s.operatorState) {
    n.operatorState = newState;
    const evts = [...s.timelineEvents];
    const logs = [...s.incidentLog];

    if (newState === SEVERITY.NOMINAL && s.operatorState > SEVERITY.NOMINAL) {
      n.replicaCount = 3;
      evts.push({ tick: n.tick, severity: 0, shape: "●", msg: "Recovered. Annotations removed. Replicas: 3." });
      n.recoveryTick = n.tick;
      n.incidentActive = false;
      logs.push({ tick: n.tick, type: "RECOVERED" });
    } else if (newState === SEVERITY.CAUTION) {
      n.cooldownRemaining = 10;
      evts.push({ tick: n.tick, severity: 1, shape: "▲", msg: "Burn rate > 2x. Deployment annotated. CI/CD gated." });
      if (!n.incidentActive) { n.incidentActive = true; n.incidentStartTick = n.tick; }
      if (!n.firstActionTick) n.firstActionTick = n.tick;
      logs.push({ tick: n.tick, type: "ANNOTATED" });
    } else if (newState === SEVERITY.WARNING) {
      n.replicaCount = 5;
      n.cooldownRemaining = 15;
      evts.push({ tick: n.tick, severity: 2, shape: "◆", msg: "Burn rate > 5x. Replicas scaled: 3 → 5." });
      if (!n.incidentActive) { n.incidentActive = true; n.incidentStartTick = n.tick; }
      if (!n.firstActionTick) n.firstActionTick = n.tick;
      logs.push({ tick: n.tick, type: "SCALED" });
    } else if (newState === SEVERITY.CRITICAL) {
      n.cooldownRemaining = 20;
      evts.push({ tick: n.tick, severity: 3, shape: "■", msg: "Burn rate > 10x. PagerDuty alert triggered." });
      if (!n.incidentActive) { n.incidentActive = true; n.incidentStartTick = n.tick; }
      if (!n.firstActionTick) n.firstActionTick = n.tick;
      logs.push({ tick: n.tick, type: "PAGED" });
    }
    n.timelineEvents = evts;
    n.incidentLog = logs;
  } else if (n.flappingEnabled && n.cooldownRemaining === 0 && db >= BURN_THRESHOLDS.CAUTION) {
    // Dampening hold during flapping
    if (!s.timelineEvents.some(e => e.msg.includes("flapping") && e.tick > n.tick - 15)) {
      n.timelineEvents = [...s.timelineEvents, { tick: n.tick, severity: -1, shape: "~", msg: "Metric flapping detected. Holding state. Dampening active." }];
    }
  }

  return n;
}

// ─── STYLE CONSTANTS ─────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Space+Grotesk:wght@300;400;500;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap');

:root {
  --bg: #080A0C;
  --surface: #111416;
  --surface-container: #1e2022;
  --surface-container-low: #1a1c1e;
  --surface-container-lowest: #0c0e10;
  --surface-container-high: #282a2c;
  --text-primary: #e2e2e5;
  --text-secondary: #6b7a8d;
  --primary: #46f1c5;
  --primary-dim: #00D4AA;
  --error: #ffb4ab;
  --error-container: rgba(147,0,10,0.15);
  --caution: #F5A623;
  --warning: #FF6B35;
  --critical: #FF3B5C;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

.slo-root {
  font-family: 'Inter', 'Geist Sans', sans-serif;
  background: var(--bg);
  background-image:
    linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
  background-size: 32px 32px;
  color: var(--text-primary);
  width: 100%; height: 100vh;
  overflow: hidden; position: relative;
}

.slo-root::after {
  content: "";
  position: fixed; top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  background: linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,0.08) 50%);
  background-size: 100% 2px;
  z-index: 200; opacity: 0.15;
}

.glass {
  background: rgba(20,25,30,0.7);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.05);
  box-shadow: inset 0 1px 1px rgba(255,255,255,0.04);
}

.mono { font-family: 'Geist Mono', monospace; }
.headline { font-family: 'Space Grotesk', sans-serif; }

@keyframes pulse-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}

@keyframes dot-flow {
  0% { offset-distance: 0%; }
  100% { offset-distance: 100%; }
}

@keyframes glow-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

.scrollbar-hide::-webkit-scrollbar { display: none; }
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
`;

// ─── HELPERS ─────────────────────────────────────────────
const fmt = (n, d = 1) => Number(n).toFixed(d);
const fmtTime = (ticks) => {
  const m = Math.floor(ticks / 60);
  const ss = ticks % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};
const severityOf = (br) => {
  if (br < BURN_THRESHOLDS.CAUTION) return 0;
  if (br < BURN_THRESHOLDS.WARNING) return 1;
  if (br < BURN_THRESHOLDS.CRITICAL) return 2;
  return 3;
};

// ─── MAIN COMPONENT ─────────────────────────────────────
export default function SLOGuardian() {
  const [state, dispatch] = useReducer(reducer, null, initState);
  const [showAbout, setShowAbout] = useState(false);
  const timelineRef = useRef(null);
  const overrideTimer = useRef(null);

  // Tick loop
  useEffect(() => {
    const id = setInterval(() => dispatch({ type: "TICK" }), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll timeline
  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [state.timelineEvents.length]);

  const s = state;
  const sev = s.operatorState;
  const sevColor = COLORS[sev];
  const isHighSev = sev >= SEVERITY.CRITICAL;
  const textPrimary = isHighSev ? "#F5F7FA" : "#e2e2e5";

  // Ghost line projection
  const ghostData = useMemo(() => {
    const h = s.burnHistory.filter(d => d.dampened != null);
    if (h.length < 5) return null;
    const recent = h.slice(-10);
    const avgRate = recent.reduce((a, b) => a + b.dampened, 0) / recent.length;
    if (avgRate < 1.2) return null;
    const drainPerSec = (avgRate - 1) * 0.3;
    const timeToExhaust = drainPerSec > 0 ? Math.round(s.errorBudgetPct / drainPerSec) : Infinity;
    return { rate: avgRate, tte: timeToExhaust > 999 ? null : timeToExhaust };
  }, [s.burnHistory, s.errorBudgetPct]);

  // Post-mortem data
  const postMortem = useMemo(() => {
    if (!s.incidentStartTick) return null;
    const mttd = s.firstActionTick ? s.firstActionTick - s.incidentStartTick : null;
    const mttr = s.recoveryTick ? s.recoveryTick - s.incidentStartTick : null;
    const peakBurn = Math.max(...s.burnHistory.map(d => d.raw || 0));
    const budgetConsumed = 100 - s.errorBudgetPct;
    return { mttd, mttr, peakBurn, budgetConsumed, actions: s.incidentLog.length, start: s.incidentStartTick };
  }, [s.incidentStartTick, s.firstActionTick, s.recoveryTick, s.burnHistory, s.errorBudgetPct, s.incidentLog]);

  // ─── RENDER ──────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="slo-root" style={{ color: textPrimary }}>
        {/* ── HEADER BAR ── */}
        <header style={{
          position: "fixed", top: 0, left: 0, right: 0, height: 48, zIndex: 50,
          background: "rgba(8,10,12,0.85)", backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 24px",
          boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)",
        }}>
          {/* Reconciliation Pulse */}
          <div style={{
            position: "absolute", top: 0, left: 0, width: "50%", height: 2,
            background: `linear-gradient(90deg, transparent, ${sevColor}, transparent)`,
            animation: s.prometheusOnline ? "pulse-sweep 1.2s cubic-bezier(0.4,0,0.2,1) infinite" : "none",
            opacity: s.prometheusOnline ? 0.8 : 0,
            transition: "opacity 0.5s",
          }} />

          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span className="headline" style={{ fontSize: 16, fontWeight: 700, color: "#00D4AA", letterSpacing: "-0.02em" }}>
              SLO GUARDIAN
            </span>
            <span className="mono" style={{ fontSize: 10, color: "#6b7a8d", letterSpacing: "0.08em" }}>
              SIMULATION
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Status chip */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "rgba(12,14,16,0.8)", padding: "4px 10px",
              border: `1px solid ${sevColor}33`,
              boxShadow: GLOW[sev],
              transition: "all 0.5s",
            }}>
              <span style={{ color: sevColor, fontSize: 10 }}>{SHAPES[sev]}</span>
              <span className="mono" style={{ fontSize: 10, color: sevColor, letterSpacing: "0.1em" }}>
                {STATE_NAMES[sev]}
              </span>
            </div>

            {/* Clock */}
            <span className="mono" style={{ fontSize: 10, color: "#6b7a8d" }}>
              {fmtTime(s.tick)}
            </span>

            {/* About */}
            <button onClick={() => setShowAbout(true)} style={{
              width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
              color: "#6b7a8d", fontSize: 10, cursor: "pointer", fontFamily: "'Geist Mono', monospace",
            }}>?</button>
          </div>
        </header>

        {/* Status message bar */}
        <div style={{
          position: "fixed", top: 48, left: 0, right: 0, height: 28, zIndex: 49,
          background: `${sevColor}08`, borderBottom: `1px solid ${sevColor}15`,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.5s",
        }}>
          <span className="mono" style={{ fontSize: 10, color: `${sevColor}cc`, letterSpacing: "0.05em" }}>
            {STATUS_MSGS[sev]}
          </span>
        </div>

        {/* ── SCENARIO BAR ── */}
        <div style={{
          position: "fixed", top: 76, left: 0, right: 0, height: 64, zIndex: 48,
          background: "rgba(12,14,16,0.6)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
        }}>
          <span className="mono" style={{ fontSize: 12, color: "#6b7a8d", letterSpacing: "0.1em", textTransform: "uppercase", marginRight: 12 }}>
            Failure Scenarios
          </span>
          {[["SLOW_BURN", "Slow Burn"], ["SUDDEN_SPIKE", "Spike"], ["CASCADE", "Cascade"], ["FLAP_STORM", "Flap Storm"]].map(([id, label]) => (
            <button key={id} className="mono" onClick={() => dispatch(s.activePreset === id ? { type: "STOP_PRESET" } : { type: "START_PRESET", preset: id })}
              style={{
                fontSize: 11, padding: "8px 18px", textTransform: "uppercase",
                letterSpacing: "0.08em", cursor: "pointer",
                background: s.activePreset === id ? "rgba(70,241,197,0.1)" : "transparent",
                border: `1px solid ${s.activePreset === id ? "rgba(70,241,197,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: s.activePreset === id ? "#46f1c5" : "#6b7a8d",
                transition: "all 0.2s",
              }}>{label}</button>
          ))}
          <div style={{ width: 1, height: 36, background: "rgba(255,255,255,0.08)", margin: "0 4px" }} />
          <button className="mono" onClick={() => dispatch({ type: "RESET" })}
            style={{
              fontSize: 8, padding: "4px 10px", textTransform: "uppercase",
              letterSpacing: "0.08em", cursor: "pointer",
              background: "transparent", border: "1px solid rgba(255,255,255,0.08)",
              color: "#6b7a8d",
            }}>Reset</button>
          {s.incidentLog.length > 0 && !s.showPostMortem && (
            <button className="mono" onClick={() => dispatch({ type: "SHOW_POST_MORTEM" })}
              style={{
                fontSize: 11, padding: "8px 18px", textTransform: "uppercase",
                letterSpacing: "0.08em", cursor: "pointer",
                background: "linear-gradient(135deg, #46f1c5, #00D4AA)",
                color: "#002118", fontWeight: 700, border: "none",
                boxShadow: "0 0 12px rgba(70,241,197,0.3)",
              }}>Post-Mortem</button>
          )}
        </div>

        {/* ── MAIN GRID ── */}
        <main style={{
          paddingTop: 76, height: "100vh", display: "grid",
          gridTemplateColumns: "30% 1fr",
          gridTemplateRows: "1fr 1fr auto",
          gap: 12, padding: "146px 12px 12px 12px",
        }}>

          {/* ── [B] ERROR BUDGET GAUGE ── */}
          <div className="glass" style={{ gridRow: "1", gridColumn: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, position: "relative", overflow: "hidden" }}>
            <span className="mono" style={{ position: "absolute", top: 12, left: 16, fontSize: 9, color: "#6b7a8d", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              SLO Error Budget
            </span>

            <GaugeArc budget={s.errorBudgetPct} burnRate={s.dampenedBurnRate} severity={sev} />

            <div style={{ display: "flex", gap: 32, marginTop: 12 }}>
              <div style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 9, color: "#6b7a8d", textTransform: "uppercase" }}>Burn Rate</div>
                <div className="mono" style={{ fontSize: 14, color: COLORS[severityOf(s.dampenedBurnRate)] }}>
                  {fmt(s.dampenedBurnRate)}x
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 9, color: "#6b7a8d", textTransform: "uppercase" }}>Budget Left</div>
                <div className="mono" style={{ fontSize: 14, color: textPrimary }}>
                  {fmt(TOTAL_BUDGET_MIN * s.errorBudgetPct / 100, 1)} min
                </div>
              </div>
            </div>
          </div>

          {/* ── [D] CHAOS CONSOLE ── */}
          <div className="glass" style={{ gridRow: "2", gridColumn: "1", display: "flex", flexDirection: "column", padding: 16, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="mono" style={{ fontSize: 9, color: "#6b7a8d", letterSpacing: "0.15em", textTransform: "uppercase" }}>
                Chaos Injection Console
              </span>
              <span style={{ color: "#FF3B5C", fontSize: 14 }}>▲</span>
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }} className="scrollbar-hide">
              <div>
                <label className="mono" style={{ fontSize: 9, color: "#6b7a8d", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
                  Error Rate: <span style={{ color: COLORS[severityOf(s.rawBurnRate)] }}>{fmt(s.sliderErrorRate, 0)}%</span>
                </label>
                <input type="range" min={1} max={80} step={1} value={s.sliderErrorRate}
                  onChange={e => dispatch({ type: "SET_ERROR_RATE", value: +e.target.value })}
                  style={{ width: "100%", accentColor: COLORS[severityOf(s.rawBurnRate)], height: 4, cursor: "pointer" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  {[1, 15, 30, 50, 80].map(v => (
                    <span key={v} className="mono" style={{ fontSize: 8, color: "#6b7a8d", cursor: "pointer" }}
                      onClick={() => dispatch({ type: "SET_ERROR_RATE", value: v })}>{v}%</span>
                  ))}
                </div>
              </div>

              {/* Toggle row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <ToggleBtn label="Prometheus" active={s.prometheusOnline} activeColor="#46f1c5" inactiveColor="#FF3B5C"
                  activeLabel="ONLINE" inactiveLabel="OFFLINE"
                  onClick={() => dispatch({ type: "TOGGLE_PROMETHEUS" })} />
                <ToggleBtn label="Flapping" active={!s.flappingEnabled} activeColor="#46f1c5" inactiveColor="#F5A623"
                  activeLabel="STABLE" inactiveLabel="FLAPPING"
                  onClick={() => dispatch({ type: "TOGGLE_FLAPPING" })} />
              </div>

              {/* Pod Kill Interlock */}
              <div style={{
                padding: 10, border: "1px solid rgba(255,59,92,0.2)",
                background: "rgba(147,0,10,0.08)", position: "relative",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span className="mono" style={{ fontSize: 9, color: "#FF3B5C", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Critical: Pod Kill
                  </span>
                  <span className="mono" style={{ fontSize: 8, color: "rgba(255,59,92,0.5)" }}>
                    {s.podKillArmed ? "ARMED" : "INTERLOCK ENGAGED"}
                  </span>
                </div>
                <SlideToExecute
                  armed={s.podKillArmed}
                  onArm={() => dispatch({ type: "ARM_POD_KILL" })}
                  onExecute={() => dispatch({ type: "KILL_PODS" })}
                  label={`KILL 2 PODS (${s.podCount}/${s.podMax})`}
                />
              </div>
            </div>
          </div>

          {/* ── [C] TELEMETRY + TIMELINE ── */}
          <div className="glass" style={{ gridRow: "1", gridColumn: "2", display: "flex", flexDirection: "column", padding: 16, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
              <div>
                <h2 className="headline" style={{ fontSize: 20, fontWeight: 300, color: textPrimary, textTransform: "uppercase", letterSpacing: "-0.01em" }}>
                  Simulation Telemetry
                </h2>
                <span className="mono" style={{ fontSize: 9, color: "#6b7a8d", letterSpacing: "0.15em" }}>
                  RUNTIME: {fmtTime(s.tick)}
                </span>
              </div>
              {ghostData?.tte && (
                <div style={{ textAlign: "right" }}>
                  <span className="mono" style={{ fontSize: 9, color: "#6b7a8d", textTransform: "uppercase" }}>Time to Exhaustion</span>
                  <div className="mono" style={{ fontSize: 16, color: COLORS[3] }}>{ghostData.tte}s</div>
                </div>
              )}
            </div>

            {/* Burn Rate Chart */}
            <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
              <BurnRateChart history={s.burnHistory} ghost={ghostData} flapping={s.flappingEnabled} />
            </div>
          </div>

          {/* ── [E] ARCHITECTURE + TIMELINE ── */}
          <div className="glass" style={{ gridRow: "2", gridColumn: "2", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", height: "100%" }}>
              {/* Architecture Diagram */}
              <div style={{ flex: 1, position: "relative", padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span className="mono" style={{ fontSize: 9, color: "#6b7a8d", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                    Operator Topology
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.prometheusOnline ? "#46f1c5" : "#FF3B5C", boxShadow: `0 0 6px ${s.prometheusOnline ? "#46f1c5" : "#FF3B5C"}`, animation: "glow-pulse 2s ease infinite" }} />
                    <span className="mono" style={{ fontSize: 9, color: "#6b7a8d" }}>{s.prometheusOnline ? "SYNC" : "OFFLINE"}</span>
                  </div>
                </div>
                <ArchitectureDiagram state={s} />
              </div>

              {/* Timeline */}
              <div style={{ width: 280, borderLeft: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "10px 12px 6px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <span className="mono" style={{ fontSize: 9, color: "#6b7a8d", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                    Action Log
                  </span>
                </div>
                <div ref={timelineRef} className="scrollbar-hide"
                  style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
                  {s.timelineEvents.slice(-30).map((evt, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 8, padding: "5px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                      opacity: i < s.timelineEvents.slice(-30).length - 5 ? 0.5 : 1,
                      transition: "opacity 0.3s",
                    }}>
                      <span style={{ color: evt.severity >= 0 ? COLORS[evt.severity] || "#6b7a8d" : "#6b7a8d", fontSize: 10, flexShrink: 0, width: 12, textAlign: "center" }}>
                        {evt.shape}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="mono" style={{ fontSize: 8, color: "#6b7a8d" }}>{fmtTime(evt.tick)}</span>
                        <div className="mono" style={{ fontSize: 9, color: "#bacac2", lineHeight: 1.4, wordBreak: "break-word" }}>
                          {evt.msg}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── FOOTER STATS ── */}
          <div style={{ gridRow: "3", gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, height: 64 }}>
            <StatCard label="Replicas" value={s.replicaCount} unit="pods" />
            <StatCard label="Error Rate" value={fmt(s.errorRate, 1)} unit="%" color={s.errorRate > 10 ? "#ffb4ab" : undefined} />
            <StatCard label="Active Pods" value={s.podCount} unit={`/ ${s.podMax}`} />
            <StatCard label="Budget" value={fmt(s.errorBudgetPct, 1)} unit="%" color={s.errorBudgetPct < 20 ? "#FF3B5C" : s.errorBudgetPct < 50 ? "#F5A623" : "#46f1c5"} />
            <StatCard label="Risk State" value={STATE_NAMES[sev]} highlight color={sevColor} />
          </div>
        </main>

        {/* ── EXHAUSTION LOCKDOWN OVERLAY ── */}
        {sev === SEVERITY.EXHAUSTED && !s.exhaustionDismissed && (
          <ExhaustionOverlay dispatch={dispatch} state={s} />
        )}

        {/* ── POST-MORTEM PANEL ── */}
        {s.showPostMortem && postMortem && (
          <PostMortemPanel data={postMortem} state={s} dispatch={dispatch} />
        )}

        {/* ── ABOUT MODAL ── */}
        {showAbout && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 150,
            background: "rgba(8,10,12,0.8)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }} onClick={() => setShowAbout(false)}>
            <div className="glass" style={{
              maxWidth: 480, padding: "24px 28px",
              boxShadow: "0 0 40px rgba(0,0,0,0.5)",
            }} onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <span className="headline" style={{ fontSize: 16, fontWeight: 700, color: "#00D4AA" }}>SLO GUARDIAN</span>
                <button onClick={() => setShowAbout(false)} style={{ background: "none", border: "none", color: "#6b7a8d", fontSize: 16, cursor: "pointer" }}>x</button>
              </div>
              <p style={{ fontSize: 13, lineHeight: 1.7, color: "#bacac2", marginBottom: 12 }}>
                An interactive simulation of a Kubernetes SLO Guardian operator. Inject chaos events and watch the operator respond in real-time with graduated actions: annotating deployments, scaling replicas, and paging on-call engineers based on error budget burn rate.
              </p>
              <p style={{ fontSize: 13, lineHeight: 1.7, color: "#bacac2", marginBottom: 16 }}>
                Built to demonstrate the reconciliation loop pattern, failure-mode awareness, dampening logic, and the full SRE lifecycle from detection to post-mortem.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <span className="mono" style={{ fontSize: 9, color: "#6b7a8d" }}>
                  Designed & built by Jake Sumsion
                </span>
                <span className="mono" style={{ fontSize: 9, color: "#46f1c5" }}>
                  jakebuildsfunthings.com
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── GAUGE ARC COMPONENT ────────────────────────────────
function GaugeArc({ budget, burnRate, severity }) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * 0.75;
  const budgetOffset = arcLength * (1 - budget / 100);
  const shadowBudget = Math.max(budget + 3, budget); // Shadow is slightly ahead
  const shadowOffset = arcLength * (1 - Math.min(100, shadowBudget) / 100);

  return (
    <div style={{ position: "relative", width: 160, height: 160 }}>
      <svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%", transform: "rotate(-225deg)" }}>
        <defs>
          <linearGradient id="gauge-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#46f1c5" />
            <stop offset="100%" stopColor="#00D4AA" />
          </linearGradient>
        </defs>
        {/* Background arc */}
        <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.04)"
          strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`} />
        {/* Shadow arc */}
        <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(70,241,197,0.08)"
          strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`}
          strokeDashoffset={shadowOffset}
          style={{ transition: "stroke-dashoffset 3s ease" }} />
        {/* Active arc */}
        <circle cx="50" cy="50" r={radius} fill="none"
          stroke={severity >= 3 ? "#FF3B5C" : severity >= 2 ? "#FF6B35" : severity >= 1 ? "#F5A623" : "url(#gauge-grad)"}
          strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`}
          strokeDashoffset={budgetOffset}
          style={{
            transition: "stroke-dashoffset 0.5s ease, stroke 0.5s ease",
            filter: severity >= 3 ? "drop-shadow(0 0 8px rgba(255,59,92,0.4))" : "drop-shadow(0 0 8px rgba(70,241,197,0.25))",
          }} />
      </svg>
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        <span className="headline" style={{
          fontSize: 40, fontWeight: 300, color: COLORS[severity],
          letterSpacing: "-0.02em", lineHeight: 1,
          transition: "color 0.5s",
        }}>
          {fmt(budget)}
        </span>
        <span className="mono" style={{ fontSize: 9, color: "#6b7a8d", textTransform: "uppercase", letterSpacing: "0.15em" }}>
          Remaining %
        </span>
      </div>
    </div>
  );
}

// ─── BURN RATE CHART ─────────────────────────────────────
function BurnRateChart({ history, ghost, flapping }) {
  const w = 800, h = 180;
  const maxY = 20;
  const data = history.slice(-CHART_WINDOW);
  const [hoverIdx, setHoverIdx] = useState(null);

  // Determine current line color from latest dampened value
  const latest = data[data.length - 1];
  const currentSev = latest?.dampened != null ? severityOf(latest.dampened) : 0;
  const lineColor = COLORS[currentSev] || "#46f1c5";

  const toX = (i) => (i / (CHART_WINDOW - 1)) * w;
  const toY = (v) => h - Math.min(v, maxY) / maxY * (h - 20) - 10;

  const rawPoints = data.map((d, i) => d.raw != null ? `${toX(i)},${toY(d.raw)}` : null).filter(Boolean);
  const dampPoints = data.map((d, i) => d.dampened != null ? `${toX(i)},${toY(d.dampened)}` : null).filter(Boolean);

  const thresholds = [
    { y: BURN_THRESHOLDS.CAUTION, label: "Caution 2x", color: "#F5A623" },
    { y: BURN_THRESHOLDS.WARNING, label: "Warning 5x", color: "#FF6B35" },
    { y: BURN_THRESHOLDS.CRITICAL, label: "Critical 10x", color: "#FF3B5C" },
  ];

  // Ghost projection
  let ghostLine = null;
  let ghostEndX = 0, ghostEndY = 0;
  if (ghost && dampPoints.length > 0) {
    const lastX = toX(data.length - 1);
    const lastY = toY(ghost.rate);
    const projX = Math.min(w, lastX + w * 0.25);
    ghostLine = `M${lastX},${lastY} L${projX},${lastY}`;
    ghostEndX = projX;
    ghostEndY = lastY;
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "100%" }} preserveAspectRatio="none"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const mouseX = ((e.clientX - rect.left) / rect.width) * w;
        const idx = Math.round((mouseX / w) * (CHART_WINDOW - 1));
        if (idx >= 0 && idx < data.length) setHoverIdx(idx);
        else setHoverIdx(null);
      }}
      onMouseLeave={() => setHoverIdx(null)}>
      {/* Y-axis labels */}
      {[1, 2, 5, 10, 15].map(v => (
        <text key={`y-${v}`} x={4} y={toY(v) + 3} fill="rgba(255,255,255,0.15)" fontSize="7" fontFamily="'Geist Mono', monospace">
          {v}x
        </text>
      ))}

      {/* Grid lines */}
      {[2, 5, 10].map(v => (
        <line key={v} x1={0} y1={toY(v)} x2={w} y2={toY(v)} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
      ))}

      {/* Inline legend */}
      <g>
        <line x1={w - 115} y1={10} x2={w - 95} y2={10} stroke={lineColor} strokeWidth={2} />
        <text x={w - 92} y={13} fill="#6b7a8d" fontSize="7" fontFamily="'Geist Mono', monospace">BURN RATE</text>
        <line x1={w - 115} y1={22} x2={w - 95} y2={22} stroke={lineColor} strokeWidth={1.5} strokeDasharray="4,4" />
        <text x={w - 92} y={25} fill="#6b7a8d" fontSize="7" fontFamily="'Geist Mono', monospace">PROJECTED</text>
      </g>

      {/* Threshold labels */}
      {thresholds.map(t => (
        <g key={t.label}>
          <line x1={0} y1={toY(t.y)} x2={w} y2={toY(t.y)} stroke={`${t.color}30`} strokeWidth={1} strokeDasharray="4,4" />
          <text x={w - 4} y={toY(t.y) - 4} fill={`${t.color}80`} fontSize="8" fontFamily="'Geist Mono', monospace" textAnchor="end">
            {t.label}
          </text>
        </g>
      ))}

      {/* Fill under dampened line */}
      {dampPoints.length > 1 && (
        <polygon
          points={`${dampPoints.join(" ")} ${toX(data.length - 1)},${h} ${toX(0)},${h}`}
          fill={`${lineColor}15`}
        />
      )}

      {/* Raw line (thin, only during flapping) */}
      {flapping && rawPoints.length > 1 && (
        <polyline points={rawPoints.join(" ")} fill="none" stroke={`${lineColor}40`} strokeWidth={1} />
      )}

      {/* Dampened line (thick) */}
      {dampPoints.length > 1 && (
        <polyline points={dampPoints.join(" ")} fill="none" stroke={lineColor} strokeWidth={2}
          style={{ filter: `drop-shadow(0 0 4px ${lineColor}50)`, transition: "stroke 0.5s" }} />
      )}

      {/* Ghost projection */}
      {ghostLine && (
        <>
          <path d={ghostLine} fill="none" stroke={`${lineColor}99`} strokeWidth={1.5} strokeDasharray="4,4" />
          <text x={ghostEndX + 4} y={ghostEndY + 3} fill={`${lineColor}80`}
            fontSize="7" fontFamily="'Geist Mono', monospace">
            PROJECTED{ghost?.tte ? ` ~${ghost.tte}s` : ""}
          </text>
        </>
      )}

      {/* Hover crosshair + tooltip */}
      {hoverIdx !== null && data[hoverIdx]?.dampened != null && (() => {
        const d = data[hoverIdx];
        const hx = toX(hoverIdx);
        const hy = toY(d.dampened);
        const hSev = severityOf(d.dampened);
        const flipLeft = hx > w - 160;
        const tx = flipLeft ? hx - 90 : hx + 8;
        const ty = Math.max(4, Math.min(hy - 30, h - 60));
        return (
          <>
            <line x1={hx} y1={0} x2={hx} y2={h} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
            <circle cx={hx} cy={hy} r={3} fill={lineColor} />
            <foreignObject x={tx} y={ty} width={85} height={56} style={{ pointerEvents: "none" }}>
              <div xmlns="http://www.w3.org/1999/xhtml" style={{
                background: "rgba(12,14,16,0.92)", border: "1px solid rgba(70,241,197,0.15)",
                padding: "4px 6px", fontFamily: "'Geist Mono', monospace", fontSize: 8,
                lineHeight: 1.6, color: "#bacac2", backdropFilter: "blur(8px)",
              }}>
                <div><span style={{ color: "#6b7a8d" }}>BURN </span><span style={{ color: COLORS[hSev] }}>{d.dampened.toFixed(1)}x</span></div>
                {d.raw != null && d.raw !== d.dampened && (
                  <div><span style={{ color: "#6b7a8d" }}>RAW </span>{d.raw.toFixed(1)}x</div>
                )}
                <div><span style={{ color: "#6b7a8d" }}>TIME </span>{fmtTime(d.tick)}</div>
                <div style={{ color: COLORS[hSev], fontSize: 7 }}>{STATE_NAMES[hSev]}</div>
              </div>
            </foreignObject>
          </>
        );
      })()}

      {/* Time labels */}
      <text x={4} y={h - 2} fill="#6b7a8d" fontSize="8" fontFamily="'Geist Mono', monospace">
        {data.length > 0 ? fmtTime(data[0].tick) : ""}
      </text>
      <text x={w - 4} y={h - 2} fill={lineColor} fontSize="8" fontFamily="'Geist Mono', monospace" textAnchor="end">
        LIVE
      </text>
    </svg>
  );
}

// ─── ARCHITECTURE DIAGRAM ────────────────────────────────
function ArchitectureDiagram({ state: s }) {
  const [activePanel, setActivePanel] = useState(null);
  const sev = s.operatorState;
  const online = s.prometheusOnline;
  const nodeColor = (isActive) => isActive ? `rgba(70,241,197,${sev >= 3 ? "0.6" : "0.4"})` : "rgba(255,255,255,0.1)";
  const dotColor = sev >= 3 ? "#FF3B5C" : sev >= 2 ? "#FF6B35" : sev >= 1 ? "#F5A623" : "#46f1c5";
  const speed = sev >= 3 ? "0.8s" : sev >= 2 ? "1.2s" : sev >= 1 ? "1.8s" : "3s";

  const nodes = [
    { id: "crd", x: 50, y: 90, label: "SLOPolicy", w: 80 },
    { id: "op", x: 200, y: 90, label: "OPERATOR", w: 80 },
    { id: "prom", x: 200, y: 180, label: "PROMETHEUS", w: 90, dim: !online },
    { id: "k8s", x: 370, y: 60, label: "K8S_API", w: 75 },
    { id: "deploy", x: 370, y: 130, label: "api-server", w: 80 },
    { id: "pd", x: 370, y: 195, label: "PAGERDUTY", w: 85 },
  ];

  const paths = [
    { id: "crd-op", d: "M130,100 C160,100 170,100 200,100", active: true },
    { id: "op-prom", d: "M240,120 C240,140 240,155 240,170", active: online },
    { id: "op-k8s", d: "M280,90 C310,75 340,68 370,68", active: sev >= 1 },
    { id: "op-deploy", d: "M280,100 C310,110 340,125 370,135", active: sev >= 2 },
    { id: "op-pd", d: "M240,120 C260,160 330,195 370,200", active: sev >= 3 },
  ];

  return (
    <svg viewBox="0 0 480 230" style={{ width: "100%", height: "100%" }}>
      <defs>
        <filter id="node-glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <linearGradient id="path-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={`${dotColor}66`} />
          <stop offset="100%" stopColor={`${dotColor}11`} />
        </linearGradient>
      </defs>

      {/* Click-away dismiss for panels */}
      {activePanel && (
        <rect x="0" y="0" width="480" height="230" fill="transparent"
          onClick={() => setActivePanel(null)} style={{ cursor: "default" }} />
      )}

      {/* Connection paths */}
      {paths.map(p => (
        <g key={p.id}>
          <path d={p.d} fill="none" stroke={p.active ? `${dotColor}33` : "rgba(255,255,255,0.05)"}
            strokeWidth={p.active ? 2 : 1}
            strokeDasharray={p.active ? "none" : "4,4"}
            style={{ transition: "all 0.5s" }} />
          {p.active && online && (
            <circle r="3" fill={dotColor} filter="url(#node-glow)">
              <animateMotion dur={speed} repeatCount="indefinite" path={p.d} />
            </circle>
          )}
        </g>
      ))}

      {/* Nodes */}
      {nodes.map(n => (
        <g key={n.id} style={{ opacity: n.dim ? 0.3 : 1, transition: "opacity 0.5s", cursor: "pointer" }}
          onClick={() => setActivePanel(activePanel === n.id ? null : n.id)}>
          <rect x={n.x} y={n.y - 18} width={n.w} height={36} rx={18} ry={18}
            fill="rgba(20,25,30,0.85)"
            stroke={n.dim ? "rgba(255,255,255,0.1)" : nodeColor(true)}
            strokeWidth={activePanel === n.id ? 2 : 1}
            style={{ filter: n.dim ? "none" : `drop-shadow(0 0 6px ${dotColor}40)` }} />
          <text x={n.x + n.w / 2} y={n.y + 4} fill={n.dim ? "#6b7a8d" : dotColor}
            fontSize="8" fontFamily="'Geist Mono', monospace" fontWeight="700"
            textAnchor="middle" style={{ textTransform: "uppercase", pointerEvents: "none" }}>
            {n.label}
          </text>
          {/* Status dot */}
          <circle cx={n.x + n.w - 6} cy={n.y - 12} r={3}
            fill={n.dim ? "#FF3B5C" : COLORS[sev]}
            style={{ filter: `drop-shadow(0 0 4px ${n.dim ? "#FF3B5C" : COLORS[sev]})` }} />
          {/* Operator: marching dashes border overlay */}
          {n.id === "op" && online && (
            <rect x={n.x} y={n.y - 18} width={n.w} height={36} rx={18} ry={18}
              fill="none"
              stroke={`${dotColor}35`}
              strokeWidth={1.5}
              strokeDasharray="8,6">
              <animate attributeName="stroke-dashoffset" from="0" to="-28"
                dur="3s" repeatCount="indefinite" />
            </rect>
          )}
        </g>
      ))}

      {/* ── Info Panels ── */}
      {activePanel && (() => {
        const panelPos = {
          crd:    { x: 5,   y: 2,   w: 185, h: 195 },
          op:     { x: 155, y: 2,   w: 200, h: 180 },
          prom:   { x: 155, y: 70,  w: 200, h: 160 },
          k8s:    { x: 240, y: 2,   w: 195, h: 170 },
          deploy: { x: 240, y: 2,   w: 200, h: 175 },
          pd:     { x: 240, y: 60,  w: 200, h: 165 },
        };
        const pos = panelPos[activePanel];
        if (!pos) return null;

        const panelStyle = {
          background: "rgba(12,14,16,0.92)", backdropFilter: "blur(12px)",
          border: "1px solid rgba(70,241,197,0.15)", padding: "10px 12px",
          fontSize: 8, fontFamily: "'Geist Mono', monospace", lineHeight: 1.7,
          color: "#6b7a8d", overflow: "auto", position: "relative",
        };
        const closeBtn = (
          <button onClick={() => setActivePanel(null)} style={{
            position: "absolute", top: 4, right: 8, background: "none", border: "none",
            color: "#6b7a8d", fontSize: 10, cursor: "pointer", lineHeight: 1, padding: 0,
          }}>x</button>
        );
        const hdr = (text) => (
          <div style={{ color: dotColor, marginBottom: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>{text}</div>
        );
        const row = (k, v, vColor) => (
          <div><span style={{ color: "#6b7a8d", display: "inline-block", width: 90 }}>{k}</span><span style={{ color: vColor || "#bacac2" }}>{v}</span></div>
        );

        const pdStatus = sev >= SEVERITY.CRITICAL ? "ALERT FIRED" : s.incidentLog.some(e => e.type === "PAGED") ? "RESOLVED" : "IDLE";
        const pdColor = sev >= SEVERITY.CRITICAL ? "#FF3B5C" : pdStatus === "RESOLVED" ? "#46f1c5" : "#6b7a8d";
        const pagedEvent = s.incidentLog.find(e => e.type === "PAGED");

        let panelContent;
        if (activePanel === "crd") {
          panelContent = (
            <>
              {hdr("spec.responses")}
              <YamlLine label="caution:" indent={1} />
              <YamlLine label="burnRateThreshold:" value="2.0" indent={2}
                highlight={sev === SEVERITY.CAUTION} hColor="#F5A623" />
              <YamlLine label="warning:" indent={1} />
              <YamlLine label="burnRateThreshold:" value="5.0" indent={2}
                highlight={sev === SEVERITY.WARNING} hColor="#FF6B35" />
              <YamlLine label="scaleUpPercent:" value="50" indent={2}
                highlight={sev === SEVERITY.WARNING} hColor="#FF6B35" />
              <YamlLine label="maxReplicas:" value="20" indent={2}
                highlight={sev === SEVERITY.WARNING} hColor="#FF6B35" />
              <YamlLine label="critical:" indent={1} />
              <YamlLine label="burnRateThreshold:" value="10.0" indent={2}
                highlight={sev >= SEVERITY.CRITICAL} hColor="#FF3B5C" />
              <YamlLine label="pagerdutyServiceKey:" value='"xai-oncall"' indent={2}
                highlight={sev >= SEVERITY.CRITICAL} hColor="#FF3B5C" />
            </>
          );
        } else if (activePanel === "op") {
          panelContent = (
            <>
              {hdr("Reconciliation Loop")}
              {row("State:", STATE_NAMES[sev], COLORS[sev])}
              {row("Last cycle:", "<1s ago")}
              {row("Cycle time:", "12ms")}
              {row("Cooldown:", s.cooldownRemaining > 0 ? `${s.cooldownRemaining}s remaining` : "None", s.cooldownRemaining > 0 ? "#F5A623" : "#bacac2")}
              {row("Dampened rate:", `${s.dampenedBurnRate.toFixed(1)}x`, COLORS[severityOf(s.dampenedBurnRate)])}
              {row("Buffer fill:", `${s.burnBuffer.filter(v => v !== 1).length}/${BUFFER_SIZE}`)}
              {row("Actions:", `${s.incidentLog.length} this session`)}
            </>
          );
        } else if (activePanel === "prom") {
          panelContent = (
            <>
              {hdr("Prometheus Connection")}
              {row("Endpoint:", "prometheus:9090")}
              {row("Status:", online ? "CONNECTED" : "UNREACHABLE", online ? "#46f1c5" : "#FF3B5C")}
              {row("Scrape int:", "15s")}
              <div style={{ marginTop: 2 }}>
                <span style={{ color: "#6b7a8d", display: "inline-block", width: 90 }}>Query:</span>
                <span style={{ color: "#bacac2" }}>rate(http_requests</span>
              </div>
              <div style={{ paddingLeft: 90 }}>
                <span style={{ color: "#bacac2" }}>{`_total{status=~"5.."}[5m])`}</span>
              </div>
              {row("Last scrape:", online ? "<1s ago" : "N/A")}
              {row("Latency:", online ? "4ms" : "---")}
            </>
          );
        } else if (activePanel === "k8s") {
          panelContent = (
            <>
              {hdr("RBAC: slo-guardian-sa")}
              {row("Namespace:", "production")}
              <div style={{ height: 4 }} />
              <div><span style={{ color: "#bacac2" }}>SLOPolicies</span><span style={{ color: "#6b7a8d" }}>  get, watch, list</span></div>
              <div><span style={{ color: "#bacac2" }}>Deployments</span><span style={{ color: "#6b7a8d" }}>  get, patch</span></div>
              <div><span style={{ color: "#bacac2" }}>Pods</span><span style={{ color: "#6b7a8d" }}>        get</span></div>
              <div style={{ height: 4 }} />
              <div style={{ color: "rgba(255,180,171,0.6)" }}>✗ delete        (not granted)</div>
              <div style={{ color: "rgba(255,180,171,0.6)" }}>✗ create        (not granted)</div>
            </>
          );
        } else if (activePanel === "deploy") {
          panelContent = (
            <>
              {hdr("Deployment: api-server")}
              {row("Replicas:", `${s.replicaCount}/${s.replicaCount} ready`)}
              {s.replicaCount > 3 && <div style={{ paddingLeft: 90, color: "#F5A623", fontSize: 7 }}>(scaled from 3)</div>}
              {row("Annotation:", `slo-guardian/state: ${STATE_NAMES[sev].toLowerCase()}`, COLORS[sev])}
              {row("Error rate:", `${s.errorRate.toFixed(1)}%`, s.errorRate > 10 ? "#FF3B5C" : "#bacac2")}
              {row("SLO target:", "99.9%")}
              {row("Pod health:", `${s.podCount}/${s.podMax} running`, s.podCount < s.podMax ? "#FF3B5C" : "#46f1c5")}
            </>
          );
        } else if (activePanel === "pd") {
          panelContent = (
            <>
              {hdr("PagerDuty Integration")}
              {row("Service:", "xai-oncall-****")}
              {row("Status:", pdStatus, pdColor)}
              {row("Incident:", pdStatus === "ALERT FIRED" && pagedEvent ? `#INC-${String(pagedEvent.tick).padStart(4, "0")}` : "---")}
              {row("Escalation:", pdStatus === "ALERT FIRED" ? "L1 on-call notified" : "---")}
            </>
          );
        }

        return (
          <foreignObject x={pos.x} y={pos.y} width={pos.w} height={pos.h}>
            <div xmlns="http://www.w3.org/1999/xhtml" style={panelStyle}>
              {closeBtn}
              {panelContent}
            </div>
          </foreignObject>
        );
      })()}

      {/* Lock icon during exhaustion */}
      {sev === SEVERITY.EXHAUSTED && (
        <text x={410} y={143} fill="#FF3B5C" fontSize="10" fontFamily="'Geist Mono', monospace" fontWeight="700">
          LOCKED
        </text>
      )}

      {/* Legend */}
      <g>
        {[["HEALTHY", "#46f1c5"], ["DEGRADED", "#ffb4ab"]].map(([label, color], i) => (
          <g key={label}>
            <circle cx={360 + i * 70} cy={224} r={3} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
            <text x={366 + i * 70} y={226} fill="#6b7a8d" fontSize="7" fontFamily="'Geist Mono', monospace">
              {label}
            </text>
          </g>
        ))}
      </g>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

function YamlLine({ label, value, indent = 0, highlight, hColor }) {
  return (
    <div style={{
      paddingLeft: indent * 12,
      borderLeft: highlight ? `3px solid ${hColor}` : "3px solid transparent",
      background: highlight ? `${hColor}10` : "transparent",
      paddingTop: 1, paddingBottom: 1, paddingRight: 4,
      transition: "all 0.4s",
    }}>
      <span style={{ color: highlight ? hColor : "#6b7a8d" }}>{label}</span>
      {value && <span style={{ color: highlight ? "#e2e2e5" : "#bacac2", marginLeft: 4 }}>{value}</span>}
    </div>
  );
}

// ─── TOGGLE BUTTON ──────────────────────────────────────
function ToggleBtn({ label, active, activeColor, inactiveColor, activeLabel, inactiveLabel, onClick }) {
  const color = active ? activeColor : inactiveColor;
  return (
    <button onClick={onClick} style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      padding: "8px 0", cursor: "pointer",
      background: `${color}08`, border: `1px solid ${color}30`,
      transition: "all 0.3s",
    }}>
      <span className="mono" style={{ fontSize: 8, color: "#6b7a8d", textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />
        <span className="mono" style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: "0.08em" }}>
          {active ? activeLabel : inactiveLabel}
        </span>
      </div>
    </button>
  );
}

// ─── SLIDE TO EXECUTE ───────────────────────────────────
function SlideToExecute({ armed, onArm, onExecute, label }) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef(null);
  const thumbW = 40;

  const handleDown = (e) => {
    if (!armed) { onArm(); return; }
    setDragging(true);
    e.preventDefault();
  };

  const handleMove = useCallback((e) => {
    if (!dragging || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left - thumbW / 2, rect.width - thumbW));
    setDragX(x);
    if (x >= rect.width - thumbW - 5) {
      setDragging(false);
      setDragX(0);
      onExecute();
    }
  }, [dragging, onExecute]);

  const handleUp = useCallback(() => {
    setDragging(false);
    setDragX(0);
  }, []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("touchmove", handleMove);
      window.addEventListener("touchend", handleUp);
      return () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        window.removeEventListener("touchmove", handleMove);
        window.removeEventListener("touchend", handleUp);
      };
    }
  }, [dragging, handleMove, handleUp]);

  return (
    <div ref={trackRef} style={{
      position: "relative", height: 32, borderRadius: 16,
      background: armed ? "rgba(12,14,16,0.9)" : "rgba(30,32,34,0.5)",
      border: `1px solid ${armed ? "rgba(255,59,92,0.2)" : "rgba(255,255,255,0.05)"}`,
      overflow: "hidden", cursor: armed ? "grab" : "pointer",
    }}>
      {/* Thumb */}
      <div
        onMouseDown={handleDown}
        onTouchStart={handleDown}
        style={{
          position: "absolute", left: armed ? dragX : 0, top: 2, bottom: 2,
          width: thumbW, borderRadius: 14,
          background: armed ? "rgba(255,59,92,0.8)" : "rgba(255,255,255,0.08)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: armed ? "grab" : "pointer",
          transition: dragging ? "none" : "left 0.3s ease, background 0.3s",
          userSelect: "none",
        }}>
        <span style={{ color: "white", fontSize: 12 }}>{armed ? "→" : "◁"}</span>
      </div>
      {/* Label */}
      <div style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center",
        justifyContent: "flex-end", paddingRight: 12, pointerEvents: "none",
      }}>
        <span className="mono" style={{ fontSize: 8, color: armed ? "rgba(255,59,92,0.5)" : "#6b7a8d", textTransform: "uppercase", fontWeight: 700 }}>
          {armed ? "Slide to Execute" : "Tap to Arm"}
        </span>
      </div>
    </div>
  );
}

// ─── STAT CARD ──────────────────────────────────────────
function StatCard({ label, value, unit, color, highlight }) {
  return (
    <div className="glass" style={{
      padding: "8px 12px", display: "flex", flexDirection: "column", justifyContent: "space-between",
      borderColor: highlight ? `${color}30` : undefined,
      background: highlight ? `${color}08` : undefined,
    }}>
      <span className="mono" style={{ fontSize: 8, color: highlight ? color : "#6b7a8d", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span className="mono" style={{ fontSize: 18, color: color || "#e2e2e5", fontWeight: highlight ? 700 : 400 }}>
          {value}
        </span>
        {unit && <span className="mono" style={{ fontSize: 8, color: "#6b7a8d", textTransform: "uppercase" }}>{unit}</span>}
      </div>
    </div>
  );
}

// ─── EXHAUSTION OVERLAY ─────────────────────────────────
function ExhaustionOverlay({ dispatch, state: s }) {
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef(null);
  const holdStart = useRef(null);

  const startHold = () => {
    holdStart.current = Date.now();
    holdTimer.current = setInterval(() => {
      const elapsed = Date.now() - holdStart.current;
      const pct = Math.min(100, (elapsed / 3000) * 100);
      setHoldProgress(pct);
      if (pct >= 100) {
        clearInterval(holdTimer.current);
        dispatch({ type: "MANUAL_OVERRIDE" });
        setHoldProgress(0);
      }
    }, 30);
  };

  const endHold = () => {
    clearInterval(holdTimer.current);
    setHoldProgress(0);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "rgba(8,10,12,0.75)", backdropFilter: "blur(2px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "fadeIn 0.5s ease",
    }}>
      <style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 16,
          padding: "8px 20px",
          border: "1px solid rgba(255,59,92,0.3)",
          boxShadow: "0 0 30px rgba(255,59,92,0.15)",
          animation: "glow-pulse 2s ease infinite",
        }}>
          <span style={{ color: "#FF3B5C", fontSize: 16 }}>⬡</span>
          <span className="mono" style={{ fontSize: 14, color: "#FF3B5C", letterSpacing: "0.15em", fontWeight: 700 }}>
            BUDGET EXHAUSTED
          </span>
        </div>

        <div className="mono" style={{ fontSize: 11, color: "#e2e2e5", letterSpacing: "0.1em", marginBottom: 8 }}>
          CI/CD PIPELINE FROZEN
        </div>
        <div className="mono" style={{ fontSize: 9, color: "#6b7a8d", lineHeight: 1.6, marginBottom: 24 }}>
          Error budget for api-server fully consumed. No deployments proceed until budget recovers or manual override.
        </div>

        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <button className="mono" onClick={() => dispatch({ type: "DISMISS_EXHAUSTION" })}
            style={{
              padding: "10px 20px", fontSize: 9, textTransform: "uppercase",
              letterSpacing: "0.1em", cursor: "pointer",
              background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
              color: "#e2e2e5",
            }}>Wait for Recovery</button>

          <button className="mono"
            onMouseDown={startHold} onMouseUp={endHold} onMouseLeave={endHold}
            onTouchStart={startHold} onTouchEnd={endHold}
            style={{
              position: "relative", padding: "10px 20px", fontSize: 9,
              textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer",
              background: holdProgress > 0 ? `rgba(255,59,92,${holdProgress / 200})` : "transparent",
              border: "1px solid rgba(255,59,92,0.3)",
              color: "#FF3B5C", overflow: "hidden",
              transition: "background 0.1s",
            }}>
            {/* Progress bar */}
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${holdProgress}%`, background: "rgba(255,59,92,0.15)",
              transition: holdProgress > 0 ? "none" : "width 0.2s",
            }} />
            <span style={{ position: "relative" }}>Hold to Override (3s)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── POST-MORTEM PANEL ──────────────────────────────────
function PostMortemPanel({ data, state: s, dispatch }) {
  const content = useMemo(() => {
    const lines = [];
    lines.push("# POST-MORTEM REPORT");
    lines.push(`Incident: api-server SLO Breach`);
    lines.push(`Generated: T+${fmtTime(s.tick)}`);
    lines.push(`SLO Target: ${SLO_TARGET}% | Window: 30d | Budget: ${TOTAL_BUDGET_MIN} min\n`);
    
    lines.push("## ROOT CAUSE");
    lines.push(`Service error rate exceeded the ${(100 - SLO_TARGET)}% SLO failure threshold.`);
    lines.push(`Peak burn rate reached ${fmt(data.peakBurn)}x normal consumption.\n`);
    
    lines.push("## INCIDENT TIMELINE");
    const relevantEvents = s.timelineEvents.filter(e => e.tick >= (data.start || 0) && e.severity !== 0 || e.msg.includes("Recover"));
    relevantEvents.forEach(e => {
      const rel = e.tick - (data.start || 0);
      lines.push(`  T+${String(rel).padStart(3, " ")}s  ${SHAPES[e.severity] || "~"}  ${e.msg}`);
    });
    
    lines.push("\n## KEY METRICS");
    lines.push(`  MTTD (time to detect):    ${data.mttd != null ? data.mttd + "s" : "N/A"}`);
    lines.push(`  MTTR (time to recover):   ${data.mttr != null ? data.mttr + "s" : "In progress"}`);
    lines.push(`  Peak burn rate:           ${fmt(data.peakBurn)}x`);
    lines.push(`  Error budget consumed:    ${fmt(data.budgetConsumed)}%`);
    lines.push(`  Budget remaining:         ${fmt(100 - data.budgetConsumed)}%`);
    lines.push(`  Operator actions taken:   ${data.actions}`);
    lines.push(`  Escalation tiers hit:     ${[data.peakBurn >= 2 ? "Caution" : null, data.peakBurn >= 5 ? "Warning" : null, data.peakBurn >= 10 ? "Critical" : null].filter(Boolean).join(" → ") || "None"}`);
    
    const hadFlapping = s.timelineEvents.some(e => e.msg.includes("flapping"));
    const hadExhaustion = s.timelineEvents.some(e => e.severity === 4);
    
    if (hadFlapping) {
      lines.push("\n## DAMPENING PERFORMANCE");
      lines.push("  Metric flapping detected during incident window.");
      lines.push("  Operator held state via windowed averaging.");
      lines.push("  No false state transitions during flap window.");
    }
    
    if (hadExhaustion) {
      lines.push("\n## BUDGET EXHAUSTION");
      lines.push("  Error budget reached 0%. CI/CD freeze activated.");
      const hadOverride = s.timelineEvents.some(e => e.msg.includes("override"));
      lines.push(`  Recovery method: ${hadOverride ? "Manual override" : "Automatic recovery"}`);
    }
    
    lines.push("\n## OPERATOR RESPONSE EVALUATION");
    lines.push("  The graduated response ladder performed as designed.");
    if (data.mttd != null) lines.push(`  Detection occurred within ${data.mttd}s of incident onset.`);
    lines.push(`  ${data.actions} automated actions were taken without manual intervention.`);
    if (data.mttr != null) lines.push(`  Full recovery achieved in ${data.mttr}s.`);
    
    return lines.join("\n");
  }, [data, s]);

  const download = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "slo-guardian-postmortem.md"; a.click();
    URL.revokeObjectURL(url);
  };

  const copy = () => {
    navigator.clipboard.writeText(content).catch(() => {});
  };

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: "50%", minWidth: 360, maxWidth: 560,
      zIndex: 100, background: "rgba(12,14,16,0.95)", backdropFilter: "blur(12px)",
      borderLeft: "1px solid rgba(255,255,255,0.08)",
      display: "flex", flexDirection: "column",
      animation: "slideIn 0.3s ease",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.5)",
    }}>
      <style>{`@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <span className="mono" style={{ fontSize: 10, color: "#46f1c5", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>
          Post-Mortem Report
        </span>
        <button onClick={() => dispatch({ type: "HIDE_POST_MORTEM" })}
          style={{ background: "none", border: "none", color: "#6b7a8d", fontSize: 18, cursor: "pointer" }}>
          x
        </button>
      </div>

      <div className="scrollbar-hide" style={{ flex: 1, overflow: "auto", padding: 20 }}>
        <pre className="mono" style={{
          fontSize: 10, lineHeight: 1.7, color: "#bacac2",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {content}
        </pre>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "12px 20px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <button className="mono" onClick={download} style={{
          flex: 1, padding: "10px 0", fontSize: 9, textTransform: "uppercase",
          letterSpacing: "0.1em", cursor: "pointer", fontWeight: 700,
          background: "linear-gradient(135deg, #46f1c5, #00D4AA)",
          color: "#002118", border: "none",
          boxShadow: "0 0 12px rgba(70,241,197,0.3)",
        }}>Download .md</button>
        <button className="mono" onClick={copy} style={{
          flex: 1, padding: "10px 0", fontSize: 9, textTransform: "uppercase",
          letterSpacing: "0.1em", cursor: "pointer",
          background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
          color: "#6b7a8d",
        }}>Copy</button>
      </div>
    </div>
  );
}
