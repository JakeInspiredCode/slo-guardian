# SLO Guardian — Interactive Simulation Dashboard

An interactive, real-time simulation of a Kubernetes SLO Guardian operator. Inject chaos events and watch the operator respond with graduated automated actions — from annotating deployments to scaling replicas to paging on-call engineers — all driven by error budget burn rate.

**Live:** [slo-guardian.vercel.app](https://slo-guardian.vercel.app)

---

## What This Is

A single-page React application that simulates the reconciliation loop of a Kubernetes operator managing Service Level Objectives. The simulation runs entirely client-side — no backend, no real cluster. The viewer triggers failures via the Chaos Console and observes the operator's automated response in real-time.

This project demonstrates:
- The Kubernetes operator reconciliation pattern (observe → compare → act)
- SRE error budget mechanics (SLO targets, burn rates, budget consumption)
- Graduated response automation (annotate → scale → page)
- Failure-mode awareness (Prometheus outages, metric flapping, budget exhaustion)
- Operational maturity (dampening logic, post-mortem generation, runbook thinking)

## Features

**Simulation Engine**
- Full reconciliation loop running on 1-second ticks
- Dampened burn rate via 20-second windowed average (circular buffer)
- Cooldown timers preventing state thrashing
- Five operator states: NOMINAL → CAUTION → WARNING → CRITICAL → EXHAUSTED

**Chaos Console**
- Error rate slider (1%–80%)
- Pod kill with slide-to-execute safety interlock
- Prometheus outage toggle (demonstrates fail-safe: no action on stale data)
- Metric flapping toggle (demonstrates dampening logic)
- Scenario presets: Slow Burn, Sudden Spike, Cascade, Flap Storm

**Observability**
- Error budget gauge with shadow burn arc (expected vs actual trajectory)
- Burn rate sparkline with severity-colored line and threshold markers
- Predictive ghost line projecting time-to-exhaustion
- Operator action timeline with severity shape encoding
- Architecture topology with animated data flow dots (speed correlates to burn rate)
- YAML Peek: click the SLOPolicy node to see live threshold highlighting

**Incident Lifecycle**
- Budget exhaustion lockdown with selective UI blur and hold-to-override
- Auto-generated post-mortem reports (MTTD, MTTR, peak burn, escalation tiers)
- Downloadable markdown post-mortem artifacts

## Tech Stack

- React 18 (single-component architecture, useReducer state machine)
- Vite 5 (build tooling)
- Inline SVG (gauge, chart, architecture diagram, animated data flow)
- Geist Mono + Space Grotesk + Inter (typography)
- Zero external component libraries — everything is hand-built

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Build

```bash
npm run build
```

Output in `dist/`.

## Design System

The UI follows a "Kinetic Command" design language — mission-critical aerospace instrumentation aesthetic with tonal layering (no hard borders), glassmorphic panels, CRT scanline overlay, and severity-driven color encoding (teal → amber → orange → red). Every severity state is double-encoded with both color and geometric shape for accessibility.

---

Built by [Jake Sumsion](https://jakebuildsfunthings.com)
