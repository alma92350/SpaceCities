/* ============================================================
   server/matchWorker.js — one match, hosted inside its own worker_threads Worker (ADR-0011, T-029).
   Runs the match's OWN 20Hz tick loop internally (server/matchLoop.js's stepMatch, driven by a real
   setInterval right here — the sim lives wherever its own state lives, never in the parent that
   spawns this worker), and speaks the wire protocol test/matchWorker.test.js documents to whichever
   thread constructed it via `new Worker("server/matchWorker.js", {workerData})`.

   WHY A WORKER, NOT JUST ANOTHER MATCH OBJECT IN THE SAME PROCESS. T-016 already fixed the entity-id
   counter onto per-state (ADR-0011's own "option A, scheduled follow-up") — the correctness defect
   that ORIGINALLY forced one-match-per-process is gone. Workers stay the right call anyway, for the
   two INDEPENDENT reasons ADR-0011 named alongside that defect: a match that throws is isolated to
   its own worker rather than taking the whole server down, and Node is single-threaded — separate
   OS threads are what actually let separate matches use the Space's 2 vCPUs at once, something no
   amount of same-process cleanup buys back. Measured before committing to this (T-029's own TASKS.md
   entry): real worker_threads overhead in this environment came in around 0.5-1.5MB RSS per worker,
   nowhere near large enough to make memory the binding constraint ADR-0011's own "Revisit if" clause
   named — CPU stays the real ceiling, exactly as that ADR anticipated.

   WIRE PROTOCOL (structured-clone postMessage, not JSON — no browser, no wire bytes to save here,
   only net/wsServerTransport.js-and-beyond's own hop to a real socket needs that):
     worker -> parent
       {type:"ready", owners, createGameStateOpts, restored, matchId}   once, right after the match
                                                      exists and is ticking — createGameStateOpts is
                                                      echoed back (the parent already has its own
                                                      copy, since it chose these opts before spawning
                                                      this worker in the first place) mainly so a
                                                      caller can confirm what it asked this worker to
                                                      boot with, the same role
                                                      net/wsServerTransport.js's own welcome message
                                                      plays one hop further out. `restored` (T-029a)
                                                      says whether a snapshot on disk WON over
                                                      createGameStateOpts — when true, the live
                                                      match's actual state came from that snapshot,
                                                      not from createGameStateOpts at all. `matchId`
                                                      (T-029b) is this match's stable identity —
                                                      recovered from the snapshot when `restored` is
                                                      true, freshly minted otherwise — echoed to
                                                      every client via the wire's own welcome message
                                                      one hop further out, so a reconnecting client
                                                      can tell "same match" from "a new one".
       {type:"commandResult", seat, seq, result}  a shape-rejection (immediate, from admit()) or an
                                                   applied/codec-rejected outcome (from emitAck,
                                                   once stepMatch actually processes it)
       {type:"state", seat, proj}                 once per seat, EVERY tick, unprompted — this
                                                   worker's own loop decides the cadence, not the
                                                   parent; RAW projectFor output, never quantized or
                                                   delta-encoded here (T-028b/c is a per-CONNECTION
                                                   concern, and only the parent knows connections)
       {type:"state", seat:SPECTATOR_SEAT, proj}  (T-037) the SAME cadence, ONE extra message per
                                                   tick, carrying projectForSpectator(...)'s full,
                                                   unfiltered view — posted unconditionally, exactly
                                                   like a real seat's own push, whether or not any
                                                   spectator is actually connected right now (again,
                                                   only the parent knows)
     parent -> worker
       {type:"command", seat, envelope}           relay one client's raw envelope for admission
       {type:"seatDisconnected", seat}   (T-036)   that seat's live connection just closed — starts
                                                    a grace-period timer, unless one is already
                                                    running for it
       {type:"setSeatAi", seat, enabled, opts}    (MCP) hand this seat to the game's own scripted
                                                    AI (enabled:true, with an optional
                                                    {strategy, difficulty} pick) or take it back
                                                    (enabled:false) — the EXPLICIT twin of the
                                                    seatDisconnected takeover below, for a client
                                                    that has no socket whose close could stand in
                                                    for "I have stepped away"; answered with one
                                                    {type:"seatController", seat, ai} message
       {type:"seatConnected", seat}      (T-036)   a real, authorized connection for that seat just
                                                    opened (first join OR a reconnect) — cancels any
                                                    pending grace timer and hands control back if the
                                                    AI had already taken over
       {type:"describeMap"}                       (agents) ask for this match's own STATIC map
                                                    reference — every node's commodity/position/max,
                                                    the map bounds, the tick rate — answered with one
                                                    {type:"mapMeta", map, nodes} message. Exists
                                                    because engine/projection.js ships a node as
                                                    {id, amount} only (a browser client regenerates
                                                    the rest from the seed; an MCP agent cannot).
                                                    Request/response, not a post at boot: the
                                                    consumer attaches its listener after an await.
       {type:"fingerprint", seat, tick, fp}  (T-040)  a seat's own periodic self-check
                                                    (net/fingerprint.js's seatFingerprint, computed
                                                    client-side) — compared against this worker's own
                                                    CURRENT match.state (the only place that state
                                                    lives); a mismatch posts {type:"desyncDetected",
                                                    seat, tick} back AND logs it (T-061's structured
                                                    logEvent) — see the branch below for why comparing against
                                                    "current", not a historical checkpoint at msg.tick,
                                                    is a deliberate v1 simplification
     worker -> parent (continued)
       {type:"seatController", seat, ai}          the answer to a setSeatAi request — whether that
                                                    seat is scripted-AI-driven now that it has
                                                    been applied
       {type:"desyncDetected", seat, tick}  (T-040)  this seat's own fingerprint report didn't match
                                                    — net/wsWorkerTransport.js relays it back to that
                                                    SAME seat's own connection only, never broadcast

   T-036 (FR-5): DISCONNECT -> AI TAKEOVER -> RECLAIM. net/wsWorkerTransport.js owns detecting a
   connect/disconnect (it already tracks bySeat, one hop further out) and relays it here as the two
   message types above — this file owns the actual GRACE PERIOD and the CONTROLLER SWAP, since only
   it holds the live match.state those controllers actually live on. Deliberately NOT event-only:
   `graceTimers` (seat -> real setTimeout handle) is what makes a reconnect BEFORE the timer fires a
   true no-op cancellation rather than a race against an already-scheduled takeover.

   Owner "ai" already has everything it needs the moment `match.state.ai` is populated:
   engine/sim.js's own tick() calls runAI(state,dt) [owner "ai", its own default] UNCONDITIONALLY,
   and engine/aiCommon.js's runAI/controllerFor are already null-safe (T-034a) — so the takeover for
   "ai" is exactly `match.state.ai = createAiController(...)`, and reclaim is exactly setting it back
   to null; nothing else has to change. Owner "player" is NOT so simple: engine/sim.js's tick() never
   automatically drives "player" (state.playerAi has always been an opt-in, caller-driven slot —
   today, only server/session.js's own `aiSeats` loop for Tier 1 self-play ever populates and drives
   it). This file has no session.js to inherit that from, so its own tick loop below drives
   state.playerAi itself, the exact same one-line pattern session.js already established, so a
   disconnected HOST'S seat can fall to AI too — FR-5 makes no distinction between the two seats.

   No difficulty/strategy/archetype preference to honor here (unlike setup.js's own splash-screen
   dials): an abandoned seat gets a plain default-opts controller — solid and unexceptional, matching
   FR-5's own "falls to AI control" without inventing a preference nothing upstream ever expressed.

   T-057 (§6.3, ADR-0007): workerData.clockPolicy === "deliberation" replaces the real-time
   setInterval tick loop below with a GATED one — the sim advances in fixed batches
   (deliberationTicksPerStep, default 20 = 1 sim second) only once every seat NOT under scripted-AI
   control (engine/controllers.js's controllerFor(state, owner) === null — the same "human/agent
   seat" test T-034a/T-042 already established) has posted {type:"endTurn", seat}, so a bench/eval
   harness gets fully reproducible outcomes (no wall-clock model latency can ever leak into how far
   the sim advanced). A watchdog (watchdogMs, default 20000) force-advances a round that never
   completes — a stalled/crashed agent's own missing seat is simply treated as a pass for that
   round, never a hang. Both are workerData-overridable the same way graceMs already is, so tests
   use tiny values instead of real production ones. Every branch below is a NEW, additive code path
   behind this explicit opt-in — every caller that omits clockPolicy (every one before this task)
   keeps the exact real-time setInterval loop, byte-for-byte unchanged.

   Deliberately never wired to graceTimers/snapshotTimer/fingerprint handling: a deliberation match
   is never reachable through any human-facing surface at all (server/lobby.js's own
   listOpenMatches excludes it, and tools/serve.js's HTTP create-match handler never forwards a
   caller-supplied clockPolicy) — nothing ever opens a real WebSocket to one, so
   seatDisconnected/seatConnected/fingerprint messages simply never arrive for it in practice.

   SNAPSHOT/RESTORE (T-029a, ADR-0012, FR-22, server/matchSnapshot.js). `workerData.dataDir`, when
   given, is where this match's own state (and matchId, T-029b) gets snapshotted so an UNEXPECTED
   restart (a crash, not a graceful one — see matchSnapshot.js's own header for why that's the
   actual target, not every deploy) can resume instead of losing the match. At boot, a snapshot
   already on disk always wins over `createGameStateOpts` — this worker has no way to tell "this is
   a genuine first boot" apart from "this is a crash recovery", and a snapshot only ever exists on
   disk if an earlier boot in this same dataDir already reached this same code path, so trusting it
   is always the right call. No dataDir (local dev, and every test that doesn't pass one) skips both
   restore and snapshotting entirely — the exact same fresh-createGameState behavior this file had
   before T-029a, now also minting a fresh matchId every such boot (T-029b) since there is nothing
   to recover an identity from.
   ============================================================ */

"use strict";

import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createGameState, createAiController } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { controllerFor } from "../engine/controllers.js";
import { surrender } from "../engine/victory.js";
import { mulberry32 } from "../engine/rng.js";
import { projectFor, projectForSpectator, SPECTATOR_SEAT } from "../engine/projection.js";
import { findPlacement } from "../engine/colliders.js";
import { productionRefusalReason } from "../engine/production.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { encode } from "../net/commandEnvelope.js";
import { createMatch, admit, stepMatch, toCommandResult, TICK_DT, TICK_MS } from "./matchLoop.js";
import { readSnapshot, writeSnapshot } from "./matchSnapshot.js";
import { seatFingerprint } from "../net/fingerprint.js";
import { logEvent } from "./log.js";

const { seed } = workerData.createGameStateOpts;
const dataDir = workerData.dataDir || null;
const restored = dataDir ? readSnapshot(dataDir) : null;
// T-034: a snapshot restore always wins (unchanged) — but for a genuinely FRESH match, the lobby
// that decided to spawn this worker already minted its own matchId (server/lobby.js's own
// createMatch) and needs THIS worker's live match to answer to that SAME id, not a second,
// independently-minted one nobody else knows about. workerData.matchId is that opt-in override;
// omitted (every test and every pre-T-034 caller), this is exactly the old self-minting behavior.
const matchId = restored ? restored.matchId : (workerData.matchId || randomUUID());
const state = restored ? restored.state : createGameState({ ...workerData.createGameStateOpts, rng: mulberry32(seed) });
const match = createMatch(state);

// Periodic, not per-tick — a snapshot only needs to be fresh enough to bound how much an
// UNEXPECTED crash can lose, not perfectly current (see this file's own header). Chosen against
// T-007a's own measured ~21s app-start outage window (TASKS.md T-029a's row, echoing T-007a): 5s
// bounds crash loss to well under a tenth of that window, nowhere near "a multi-minute worst
// case" the row explicitly says NOT to size against. What this has NOT been checked against is
// real write cost on HF's actual persistent storage, which docs/analysis/04-hf-deployment.md
// already characterizes as object storage rather than POSIX-latency local disk — TASKS.md's own
// open uncertainty U5 tracks that measurement separately and explicitly; this interval is a
// reasoned starting point against the outage-window math above, not a claim U5 is resolved.
const SNAPSHOT_INTERVAL_MS = 5000;
const snapshotTimer = dataDir ? setInterval(() => writeSnapshot(dataDir, matchId, match.state), SNAPSHOT_INTERVAL_MS) : null;

// T-036 (FR-5): long enough that net/wsClientTransport.js's own automatic reconnect (T-029b, a
// ~1.5s retry cadence) has resolved a genuine network blip many times over before this ever fires —
// this grace period is for "really gone" (closed the tab, closed the laptop), not a dropped packet.
// workerData-overridable so tests don't have to wait 20 real seconds per case.
const GRACE_MS = Number.isFinite(workerData.graceMs) ? workerData.graceMs : 20000;
const graceTimers = new Map();   // seat -> real setTimeout handle, only while counting down

// T-057: deliberation mode's own tuning, both workerData-overridable (tests use tiny values) —
// see this file's own header. clockPolicy defaults to "realtime" for anything other than the
// literal opt-in string, so a typo/unexpected value never silently disables the ordinary loop.
const clockPolicy = workerData.clockPolicy === "deliberation" ? "deliberation" : "realtime";
const DELIBERATION_TICKS_PER_STEP = Number.isFinite(workerData.deliberationTicksPerStep) ? workerData.deliberationTicksPerStep : 20;
const WATCHDOG_MS = Number.isFinite(workerData.watchdogMs) ? workerData.watchdogMs : 20000;
let readySeats = new Set();
let watchdogTimer = null;

// Owner "ai" already has state.ai (engine/sim.js's own built-in, unconditional runAI call); owner
// "player" needs its own state.playerAi (this file's own tick loop below drives it explicitly,
// since the engine never does) — see this file's own header for why the two aren't symmetric.
function aiSlotFor(owner) { return owner === "ai" ? "ai" : "playerAi"; }

match.emitAck = rec => {
  parentPort.postMessage({ type: "commandResult", seat: rec.owner, seq: rec.seq, result: explainResult(toCommandResult(rec.result), rec) });
};

// Agent-observability: the NUMBERS behind a refusal, added here because this is the last place a
// rejection passes through that can still see the state it was judged against. The reason codes
// themselves ("cannot-afford", "supply-capped", "invalid-placement") already say which rule said
// no; what they do not say is whether the answer is "wait six seconds" or "you are never getting
// this" — and a recorded match was lost to exactly that ambiguity: an agent 25 ore short of a
// Foundry read "cannot-afford", retried blind four times over a minute, and never learned it was
// twenty seconds of mining away from the thing that would have saved it.
function explainResult(result, rec) {
  if (result.ok || !result.reason) return result;
  const cmd = rec.cmd;
  const detail = shortfallFor(rec.owner, cmd, result.reason);
  return detail ? { ...result, detail } : result;
}

// What a cost-shaped refusal actually costs, and how long the seat's CURRENT treasury is from
// covering it. The rate is measured over this match's own recent history (see incomeWindow below)
// rather than assumed, so "60 seconds away" reflects the economy the seat really has, including
// one that has stopped earning entirely (reported as null: not slow, never).
function shortfallFor(owner, cmd, reason) {
  const player = match.state.players[owner];
  if (!player) return null;
  if (reason === "cannot-afford") {
    const cost = costOf(cmd);
    if (!cost) return null;
    const short = {};
    for (const [com, amount] of Object.entries(cost)) {
      const have = player.resources[com] ?? 0;
      if (amount > have) short[com] = Math.ceil(amount - have);
    }
    const eta = etaForShortfall(owner, short);
    return { cost, have: { ...player.resources }, short, ...(eta === null ? {} : { seconds_until_affordable: eta }) };
  }
  if (reason === "supply-capped") {
    // Names the fix rather than the symptom: which building raises the cap, and by how much.
    // The cheapest building that actually raises the cap (engine/supply.js reads supplyGrants),
    // Command Centers excluded — nobody is founding a second one to train one more Bastion.
    const supplyBuilding = Object.values(BUILDINGS)
      .filter(b => (b.supplyGrants || 0) > 0 && !b.isCommandCenter)
      .sort((a, b) => (a.cost?.ore ?? Infinity) - (b.cost?.ore ?? Infinity))[0];
    return {
      supply: supplyUsed(match.state, owner), supply_cap: supplyCap(match.state, owner),
      ...(supplyBuilding ? { fix: `build ${supplyBuilding.id}`, adds_supply: supplyBuilding.supplyGrants } : {}),
    };
  }
  if (reason === "invalid-placement" && cmd?.t === "build") {
    // A placement refusal is the one refusal with a mechanical answer, so give it: the nearest
    // spot that WOULD have worked. Three commands were burned hunting for one by hand in a
    // recorded match, at the exact moment the building was needed.
    const site = findPlacement(match.state, cmd.b, cmd.x, cmd.y);
    return site
      ? { nearest_legal_site: { x: Math.round(site.x), y: Math.round(site.y) },
          hint: "re-issue the build there, or pass `near` instead of x/y and the server picks it for you" }
      : { hint: "nowhere near this point can hold that building — pick a different area" };
  }
  return null;
}

function costOf(cmd) {
  if (cmd?.t === "build") return BUILDINGS[cmd.b]?.cost ?? null;
  if (cmd?.t === "queueProduction") {
    const def = UNITS[cmd.u];
    if (!def) return null;
    return (cmd.alt && def.altCost) ? def.altCost : def.cost;
  }
  return null;
}

// A rolling per-owner sample of the treasury, the worker-side twin of the estimate
// server/mcpObservationCache.js publishes to observation tools — kept here too because a rejection
// is answered inside the worker, where that cache does not reach.
const incomeWindowSeconds = 30;
/** @type {Map<string, {time: number, resources: Object}[]>} */
const incomeSamples = new Map();
function sampleIncome() {
  for (const owner of match.state.owners) {
    const samples = incomeSamples.get(owner) ?? [];
    const last = samples[samples.length - 1];
    if (last && match.state.time - last.time < 1) continue;
    samples.push({ time: match.state.time, resources: { ...match.state.players[owner].resources } });
    while (samples.length > 1 && match.state.time - samples[0].time > incomeWindowSeconds) samples.shift();
    incomeSamples.set(owner, samples);
  }
}

function etaForShortfall(owner, short) {
  const samples = incomeSamples.get(owner) ?? [];
  if (samples.length < 2) return null;
  const seconds = samples[samples.length - 1].time - samples[0].time;
  if (seconds <= 0) return null;
  let worst = 0;
  for (const [com, amount] of Object.entries(short)) {
    // GROSS delivery rate, summed from the positive steps only — the same reasoning
    // server/mcpObservationCache.js's own incomeFor uses: a seat that just spent its treasury has
    // a negative NET rate, and "you will never afford this" is the wrong answer to give someone
    // whose workers are mining perfectly well.
    let gained = 0;
    for (let i = 1; i < samples.length; i++) {
      gained += Math.max(0, (samples[i].resources[com] ?? 0) - (samples[i - 1].resources[com] ?? 0));
    }
    const rate = gained / seconds;
    if (rate <= 0) return null;   // not earning this at all — "soon" would be a lie
    worst = Math.max(worst, amount / rate);
  }
  return Math.round(worst);
}

parentPort.on("message", msg => {
  // "Say that again": re-answers the ready message above for a parent that attached too late to
  // hear it the first time. Idempotent and read-only — it reports what this worker already is, and
  // starts nothing — so it is safe to ask at any point in a match's life, and safe to ask twice.
  if (msg.type === "ready?") {
    parentPort.postMessage(readyMessage());
    return;
  }
  if (msg.type === "command") {
    const admitted = admit(match, msg.envelope, msg.seat);
    // Mirrors net/wsServerTransport.js's own in-process reasoning exactly: a shape-rejected
    // envelope never reaches stepMatch, so emitAck never fires for it — answer immediately or the
    // client's own submitCommand() promise hangs forever. A shape-ACCEPTED envelope's real outcome
    // always arrives later, through emitAck, once it's actually due.
    if (!admitted.ok) {
      const seq = msg.envelope && Number.isInteger(msg.envelope.seq) ? msg.envelope.seq : null;
      if (seq !== null) parentPort.postMessage({ type: "commandResult", seat: msg.seat, seq, result: { ok: false, code: admitted.code } });
    }
    return;
  }
  if (msg.type === "findBuildSite") {
    // The nearest spot that would actually accept this building, using the engine's OWN placement
    // rule (engine/colliders.js) rather than a second, drifting copy of it on the main thread —
    // which has no state to check against in any case.
    const site = findPlacement(match.state, msg.buildingType, msg.x, msg.y);
    parentPort.postMessage({ type: "buildSite", reqId: msg.reqId,
      site: site ? { x: Math.round(site.x), y: Math.round(site.y) } : null });
    return;
  }
  if (msg.type === "productionPlan") {
    // A STANDING ORDER: "keep making these, paying for them as the ore arrives." See
    // applyProductionPlans below for why this is the single highest-value thing an agent can be
    // given over this transport.
    if (!match.state.owners.includes(msg.seat)) return;
    if (msg.action === "set") productionPlans.set(msg.seat, normalisePlan(msg.plan));
    if (msg.action === "clear") productionPlans.delete(msg.seat);
    parentPort.postMessage({ type: "productionPlan", seat: msg.seat, reqId: msg.reqId, plan: productionPlans.get(msg.seat) ?? [] });
    return;
  }
  if (msg.type === "describeMap") {
    // Agent-observability: the STATIC half of this match's map — what each resource node actually
    // is and where, plus map bounds and tick rate. engine/projection.js deliberately ships only
    // {id, amount} per node, because a browser client regenerates the rest deterministically from
    // the seed it already has; an MCP agent has no map generator and so had no way to learn a
    // node's commodity except by walking a worker to it and watching which counter moved — the
    // single gap that makes "mine the closest ore" an unanswerable instruction over MCP.
    // Request/response rather than an unprompted post at boot, because a consumer
    // (server/mcpObservationCache.js) attaches its listener AFTER an await in tools/serve.js and
    // would miss a one-shot message sent before that.
    // No fog is bypassed by answering this in full: the merge on the other side is keyed by the
    // ids in that seat's OWN fog-filtered proj.nodes, so an undiscovered node stays invisible —
    // this adds detail to nodes a seat can already see, never nodes. Node positions are in any
    // case already public to any client that can regenerate the map from the seed.
    parentPort.postMessage({
      type: "mapMeta",
      map: { width: match.state.map.width, height: match.state.map.height, planetId: match.state.planetId, tickRate: Math.round(1000 / TICK_MS) },
      nodes: match.state.map.nodes.map(n => ({ id: n.id, com: n.com, x: n.x, y: n.y, max: n.max, hidden: !!n.hidden })),
    });
    return;
  }
  if (msg.type === "surrender") {
    // T-059a (FR-8): the real network trigger single-player already has (boot.js/overlays.js/
    // starmap.js all call this exact same engine/victory.js function) and multiplayer never did.
    // Nothing else needs to happen here: engine/victory.js's own surrender() doesn't end the match
    // immediately, only marks this seat eliminated — the very next regular tick's own stepMatch ->
    // checkWinCondition resolves state.over/winner/winReason from that, the identical one-tick
    // latency every other elimination (a lost Command Center, T-046) already has. Same
    // defense-in-depth guard endTurn already uses above: a scripted-AI-controlled seat has no real
    // connection (WebSocket or MCP seat handle) to ever send this from.
    if (!controllerFor(match.state, msg.seat)) surrender(match.state, msg.seat);
    return;
  }
  if (msg.type === "endTurn") {
    // Only a REQUIRED seat's own call counts — a scripted-AI-controlled owner never sends this
    // message at all (it has no MCP tool call driving it), so this guard is defense-in-depth
    // against a malformed/stray message, not something a real caller would ever hit.
    if (clockPolicy !== "deliberation" || controllerFor(match.state, msg.seat)) return;
    readySeats.add(msg.seat);
    const required = match.state.owners.filter(o => !controllerFor(match.state, o));
    if (required.every(o => readySeats.has(o))) advanceDeliberationRound();
    return;
  }
  if (msg.type === "setSeatAi") {
    // Agent seat handover (MCP set_seat_controller): the EXPLICIT, caller-driven twin of the
    // seatDisconnected grace-period takeover just below — same one-line swap on the same slot,
    // the only difference being who decided it. An MCP client has no socket whose close this
    // worker could notice (it speaks in one-shot HTTP tool calls), so "I am stepping away, let
    // the game's own AI play my seat" and "I am back" have to be things it can SAY. Honors the
    // caller's own strategy/difficulty pick, unlike the disconnect path's deliberate plain
    // default — here a preference was actually expressed, so there is one to honor.
    const slot = aiSlotFor(msg.seat);
    if (!match.state.owners.includes(msg.seat)) return;
    // A handover also cancels any grace countdown: whichever answer the caller just gave is the
    // current one, and a timer firing afterwards would silently overwrite a "no, I am playing".
    const timer = graceTimers.get(msg.seat);
    if (timer) { clearTimeout(timer); graceTimers.delete(msg.seat); }
    if (msg.enabled) {
      match.state[slot] = createAiController(match.state.planetId, {
        strategy: msg.opts?.strategy, difficulty: msg.opts?.difficulty,
      });
      logEvent("aiHandover", { matchId, seat: msg.seat, strategy: msg.opts?.strategy ?? null, difficulty: msg.opts?.difficulty ?? null });
    } else if (match.state[slot]) {
      match.state[slot] = null;
      logEvent("aiHandback", { matchId, seat: msg.seat });
    }
    parentPort.postMessage({ type: "seatController", seat: msg.seat, ai: !!match.state[slot] });
    return;
  }
  if (msg.type === "seatDisconnected") {
    if (graceTimers.has(msg.seat)) return;   // already counting down — a second close for the same seat is not a second grace period
    logEvent("seatDisconnected", { matchId, seat: msg.seat });
    graceTimers.set(msg.seat, setTimeout(() => {
      graceTimers.delete(msg.seat);
      const slot = aiSlotFor(msg.seat);
      if (!match.state[slot]) {
        match.state[slot] = createAiController(match.state.planetId, {});
        logEvent("aiTakeover", { matchId, seat: msg.seat });
      }
    }, GRACE_MS));
    return;
  }
  if (msg.type === "seatConnected") {
    const timer = graceTimers.get(msg.seat);
    // A genuine reconnect (mid-grace, or after AI had already taken over) is worth an operational
    // log line; seatConnected ALSO fires for a seat's very first join (this file's own header),
    // which is not a reconnect at all and would just be noise here.
    const wasAway = !!timer || !!match.state[aiSlotFor(msg.seat)];
    if (timer) { clearTimeout(timer); graceTimers.delete(msg.seat); }
    // Hands control back unconditionally — a harmless no-op if the grace period never actually
    // fired (already null), the real point if it did.
    match.state[aiSlotFor(msg.seat)] = null;
    if (wasAway) logEvent("seatReconnected", { matchId, seat: msg.seat });
    return;
  }
  if (msg.type === "fingerprint") {
    // T-040 (FR-20): compared against THIS worker's own CURRENT match.state — not a historical
    // checkpoint at msg.tick — a deliberate v1 simplification (net/fingerprint.js's own header
    // documents why this file is the only place that can do the comparison at all: match.state
    // lives only here). Under real network latency a client's own report always reflects a tick
    // slightly behind whatever this worker is at by the time it arrives, so an occasional benign
    // mismatch from tick drift alone is possible — acceptable for what this is: an operations
    // signal a human reviews (logEvent below — one structured JSON line, T-061), never an
    // enforcement action (no disconnect, no correction), so a rare false positive costs a look at
    // a log line, not a wrongly-punished player. A genuine, sustained divergence (the actual
    // target) reproduces on every report, tick drift or not.
    const expected = seatFingerprint(match.state, msg.seat);
    if (expected !== msg.fp) {
      logEvent("desync", { matchId, seat: msg.seat, tick: msg.tick });
      parentPort.postMessage({ type: "desyncDetected", seat: msg.seat, tick: msg.tick });
    }
    return;
  }
});

// The one message every attachment needs before it can route anything (net/wsWorkerTransport.js's
// attachWsMatchWorker resolves on it). It is posted EAGERLY, as it always was, so the ordinary
// attach-immediately path costs nothing — but a Worker's port is flowing from construction, so this
// is DROPPED, not queued, if the parent has not attached its listener yet. That is an ordinary
// shape (spawn several workers, attach to each in turn) and it used to leave the parent bound to
// `matchId: undefined`, rejecting every upgrade in silence. So the same answer is also available on
// REQUEST below: a parent that missed this one asks for it, rather than waiting forever for a
// message that has already been and gone.
function readyMessage() {
  return { type: "ready", owners: match.state.owners, createGameStateOpts: workerData.createGameStateOpts, restored: !!restored, matchId };
}
parentPort.postMessage(readyMessage());

// T-036: state.playerAi driven explicitly, BEFORE stepMatch — engine/sim.js's own tick() only ever
// auto-drives "ai" (its own hardcoded default), so a disconnected HOST's seat needs this file to do
// for "player" what the engine already does for "ai" on its own. Same ordering server/session.js's
// own aiSeats loop already established (AI decisions before the sim step that acts on them, so both
// AI-driven owners get applied at the same relative tick position). Shared verbatim by both clock
// policies below — advancing the sim by exactly one tick is the same operation either way; only
// WHEN it happens, and whether every intermediate tick gets its own state push, differs.
// ===== Standing production orders (agent-observability) =====
// An agent's think time is measured in tens of seconds and this sim ticks twenty times a second,
// so the single most expensive thing about playing over a request/response transport is that
// every decision only holds until the next one. Both recorded matches show the same shape: an
// agent decides "keep making Bastions", cannot afford one at the instant it looks, and by the
// time it looks again it has been out-produced — not out-thought. A standing order survives that
// gap. It is not a second command path: each attempt is funnelled through admit() as an ordinary
// envelope, so it is validated, logged, rate-limited by supply and cost, and replayable exactly
// like a command the agent typed itself.
/** @type {Map<string, Array<{building:string, unit:string, alt:boolean, remaining:number, maxQueued:number}>>} */
const productionPlans = new Map();
// Plan-issued envelopes need seq numbers that can never collide with the seat's own client seqs
// (admit() dedupes by (owner, seq), so a collision would silently swallow a real command).
let planSeq = 1e9;

function normalisePlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan.slice(0, 8).map(entry => ({
    building: String(entry.building ?? ""),
    unit: String(entry.unit ?? ""),
    alt: !!entry.alt,
    // A plan is a commitment, not a subscription: it counts down and stops, so an agent that
    // stops paying attention cannot leave a match spending its whole economy on one unit type
    // forever. `repeat` is clamped rather than refused so a caller asking for 1000 gets 50.
    remaining: Math.max(1, Math.min(50, Math.floor(Number(entry.repeat ?? 1)) || 1)),
    // How deep this plan is willing to fill one building's queue. Default 2: enough that the
    // building never idles between jobs, shallow enough that the plan cannot swallow the ore a
    // tech building or an expansion was being saved for.
    maxQueued: Math.max(1, Math.min(8, Math.floor(Number(entry.max_queued ?? 2)) || 2)),
  })).filter(entry => entry.building && entry.unit);
}

function applyProductionPlans() {
  for (const [owner, plan] of [...productionPlans]) {
    for (const entry of plan) {
      if (entry.remaining <= 0) continue;
      const building = match.state.buildings.get(entry.building);
      // A plan whose building is gone (razed, or never owned) is finished, not retried forever.
      if (!building || building.owner !== owner) { entry.remaining = 0; continue; }
      if (building.queue.length >= entry.maxQueued) continue;
      // The engine's own refusal check, asked BEFORE spending an admit: a plan that fires blindly
      // every tick would fill the command log with rejections and teach an observer nothing.
      if (productionRefusalReason(match.state, entry.building, entry.unit, entry.alt) !== null) continue;
      admit(match, encode({ t: "queueProduction", building: entry.building, u: entry.unit, ...(entry.alt ? { alt: true } : {}) }, planSeq++, null), owner);
      entry.remaining -= 1;
      if (entry.remaining === 0) {
        // Announced, because the whole point of a plan is that the agent is not watching: it needs
        // to learn that the thing it set up has run out, at the moment it runs out. Owner-scoped,
        // so it reaches that seat's projection and no one else's (engine/projection.js).
        match.state.events.push({ type: "planExhausted", owner, id: entry.building, unitType: entry.unit,
                                  x: building.x, y: building.y });
      }
    }
    const live = plan.filter(entry => entry.remaining > 0);
    if (live.length === 0) productionPlans.delete(owner);
    else productionPlans.set(owner, live);
  }
}

function stepOnce() {
  if (match.state.playerAi) runAI(match.state, TICK_DT, "player");
  // Plans are tried BEFORE the step that applies commands, so a standing order behaves exactly
  // like an agent that happened to be watching at this tick — same admission path, same
  // INPUT_DELAY_TICKS, same ordering against everything else due.
  applyProductionPlans();
  sampleIncome();
  stepMatch(match, TICK_DT);
}

function pushState() {
  for (const seat of match.state.owners) {
    parentPort.postMessage({ type: "state", seat, proj: projectFor(match.state, seat) });
  }
  // T-037 (FR-7): posted unconditionally, every push, exactly like each real seat's own push above
  // — this worker has no idea whether any spectator is actually connected (that bookkeeping is
  // entirely net/wsWorkerTransport.js's own job, one hop further out), so it doesn't try to know.
  parentPort.postMessage({ type: "state", seat: SPECTATOR_SEAT, proj: projectForSpectator(match.state) });
  // Bugfix: drain now that every seat's (and the spectator's) own fog-filtered proj.events has
  // already captured this tick's events by value above — mirrors boot.js's single-player
  // `state.events.length = 0`. Without this, state.events grew for a live match's ENTIRE
  // lifetime (server/mcpObservationCache.js's own header used to document this as deliberate, for
  // wait_for_event's fog-correct baseline diffing), which broke engine/projectionDelta.js's own
  // assumption that a projection's `events` field is "already this tick's new events only": every
  // WS-relayed human client re-received the match's FULL event history on every single tick and
  // replayed it in full (boot.js's processFrameEvents draining its own copy every frame didn't
  // help — the very next network push repopulated it), so any attack's tracer/sound/death-flash
  // kept re-firing forever, worst on a fast-firing unit. Draining here doesn't regress
  // wait_for_event: its baseline-vs-later-pushes diff (mcpObservationCache.js) only needs
  // "genuinely new since the call", which holds whether a tick's proj.events is the whole history
  // or (as now) just that tick's own — it only ever aggregates across however many pushes land
  // between the call and the resolve.
  match.state.events.length = 0;
}

// A finished match has no more state to advance and no one left who should keep paying its
// CPU/bandwidth cost — shared end-of-match cleanup for both clock policies (T-057's own
// deliberation path has no dataDir/graceTimers in practice per this file's own header, but a
// stray one left running costs nothing to also stop here).
function stopMatchTimers(tickTimer) {
  // Only ever called once match.state.over is true (both call sites below gate on it first) — safe
  // to log the match's own final outcome unconditionally right here, the one place both clock
  // policies' end-of-match paths already converge.
  logEvent("matchEnded", { matchId, tick: match.state.tick, time: match.state.time, winner: match.state.winner, winReason: match.state.winReason ?? null });
  if (tickTimer) clearInterval(tickTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  for (const timer of graceTimers.values()) clearTimeout(timer);
  graceTimers.clear();
}

// NFR-2: < 25ms of server-side work per tick (a 4-seat Gigantic-map late game, HF free-tier CPU) —
// workerData-overridable the same way graceMs/watchdogMs/deliberationTicksPerStep already are, so
// a test can force (or rule out) an overrun deterministically instead of depending on real machine
// speed. Deliberately not wired into deliberation mode below — it advances a whole batch of ticks
// silently and by design answers to no wall-clock-per-tick budget at all (this file's own header).
const TICK_BUDGET_MS = Number.isFinite(workerData.tickBudgetMs) ? workerData.tickBudgetMs : 25;

if (clockPolicy === "realtime") {
  // T-035 (FR-6): a final push still goes out WITH `over: true` (so every connected client's own
  // showGameOver fires — see boot.js's render loop, which already reads game.state.over
  // generically, T-030's own seam), but nothing ticks or pushes again after.
  const tickTimer = setInterval(() => {
    const t0 = performance.now();
    stepOnce();
    pushState();
    const elapsedMs = performance.now() - t0;
    if (elapsedMs > TICK_BUDGET_MS) logEvent("tickOverrun", { matchId, tick: match.state.tick, elapsedMs: Math.round(elapsedMs * 100) / 100 });
    if (match.state.over) stopMatchTimers(tickTimer);
  }, TICK_MS);
} else {
  // T-057: one push for the starting tick=0 state — an agent needs to see what it's starting with
  // to decide its own first turn — then no interval at all: the first ROUND advances only once
  // every required seat has posted its own endTurn (the message handler above) or this initial
  // watchdog fires first, whichever happens first. advanceDeliberationRound re-arms the next
  // round's own watchdog itself.
  pushState();
  armDeliberationWatchdog();
}

function armDeliberationWatchdog() {
  watchdogTimer = setTimeout(advanceDeliberationRound, WATCHDOG_MS);
}

// T-057 (§6.3, ADR-0007): a whole round — up to DELIBERATION_TICKS_PER_STEP ticks, advanced
// SILENTLY (no per-tick state push; an eval harness never asked to see N-1 throwaway intermediate
// frames) — then ONE state push reflecting the round's own final tick. endTurnResult is posted
// BEFORE that push, deliberately: it's the signal a caller's own sequential "await the result, THEN
// await the resulting state" awaits in that order (test/matchWorker.test.js's own T-057 cases), and
// since each postMessage is delivered as its own turn on the receiving side, sending the smaller,
// order-defining message first is what makes that chaining reliable rather than racy.
function advanceDeliberationRound() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  readySeats = new Set();
  for (let i = 0; i < DELIBERATION_TICKS_PER_STEP && !match.state.over; i++) stepOnce();
  parentPort.postMessage({ type: "endTurnResult", tick: match.state.tick });
  pushState();
  if (match.state.over) { stopMatchTimers(null); return; }
  armDeliberationWatchdog();
}
