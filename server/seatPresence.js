/* ============================================================
   server/seatPresence.js — AI cover for an MCP seat whose holder has gone quiet, and hand-back the
   moment they speak again.

   WHY THIS EXISTS, given T-036 already built disconnect -> AI takeover -> reclaim. That mechanism
   is driven entirely by a WebSocket closing (net/wsWorkerTransport.js relays seatDisconnected, and
   server/matchWorker.js starts a grace timer). It cannot fire for an MCP seat, because an MCP
   client has NO CONNECTION TO LOSE: it speaks in one-shot HTTP tool calls, and the gap between two
   of them is the only evidence of anything. So an agent that stopped calling — compacted its
   context, crashed, hit its own timeout — left a seat that simply FROZE: workers standing still,
   production idle, nothing defending, while the opponent played on and won. Observed in a real
   Sonnet session: the agent compacted at ~10 minutes and its base never moved again.

   set_seat_controller (server/mcpActionTools.js) is the deliberate, agent-driven version of this
   and stays the better path — an agent that KNOWS it is about to pause should say so. This is the
   safety net for the case that matters most: an agent cannot announce a pause it did not see
   coming, and "it should have told us" is not a recovery mechanism.

   THE RULE, in full: a seat held by someone, in a live match, silent for longer than idleMs, is
   handed to the game's own AI. The seat's next tool call hands it straight back. That is it —
   there is no second grace period, no escalation, and nothing is ever taken away from the holder:
   the seat, its token and its client_id are all untouched, so this is invisible to every recovery
   path (join_match's client_id rejoin, reclaim_seat) and costs the returning agent nothing but a
   get_situation to see what changed.

   WHAT IT DELIBERATELY WILL NOT DO. A seat the agent itself handed to the AI (an explicit
   set_seat_controller) is marked manual and never auto-handed-back, or an agent that steps away and
   then keeps watching the match through get_situation would silently take its own seat back while
   still intending to be away. Manual and automatic cover are tracked apart for exactly that reason.
   ============================================================ */

"use strict";

import { logEvent } from "./log.js";

// Long enough that ordinary deliberation never trips it — a model thinking hard between turns, a
// slow tool round trip, a wait_for_event blocking for its full 20s cap — and short enough that a
// frozen seat does not lose the match before anyone notices. A compaction takes far longer than
// this; a turn does not.
const DEFAULT_IDLE_MS = 90000;
// How often the sweep runs. Coarse on purpose: this decides when a seat is ALREADY abandoned, so
// a few seconds of extra latency costs nothing, and a tight interval would just be a timer waking
// the event loop for nothing on an idle server.
const DEFAULT_CHECK_EVERY_MS = 5000;

/**
 * @param {Object} opts
 * @param {Object} opts.lobby a createLobby() instance
 * @param {(matchId:string) => {setSeatAi?:(seat:string, enabled:boolean, opts?:Object)=>Promise<Object>}|null} opts.getBridge
 *   a live match's own command bridge (tools/serve.js's liveMatches) — null for a match with no
 *   worker, which is exactly the set this must skip: a match that has not started has no seat to
 *   cover, and one that has finished has nothing left to play.
 * @param {(matchId:string) => boolean} [opts.isLive] whether this match still has a running worker
 * @param {number} [opts.idleMs]
 * @param {number} [opts.checkEveryMs]
 */
export function createSeatPresence({ lobby, getBridge, isLive = () => true, idleMs = DEFAULT_IDLE_MS, checkEveryMs = DEFAULT_CHECK_EVERY_MS }) {
  // `${matchId}:${owner}` for every seat THIS module put under AI cover — never one the agent
  // asked for itself (see this file's own header).
  const autoCovered = new Set();
  const manuallyCovered = new Set();
  let timer = null;

  const key = (matchId, owner) => `${matchId}:${owner}`;

  async function coverSeat(matchId, seatIndex, owner, idle) {
    const bridge = getBridge(matchId);
    if (!bridge?.setSeatAi) return;
    autoCovered.add(key(matchId, owner));
    logEvent("agentSeatIdleCover", { matchId, seat: owner, idleSeconds: Math.round(idle / 1000) });
    await bridge.setSeatAi(owner, true, {});
  }

  /**
   * One sweep. Exported (rather than only run by the timer) so a test can drive it deterministically
   * instead of waiting out a real interval.
   * @param {number} [nowMs]
   */
  async function sweep(nowMs = Date.now()) {
    for (const match of lobby.matches.values()) {
      if (match.status !== "started" || !isLive(match.id)) continue;
      for (const [seatIndex, seat] of match.seats.entries()) {
        if (!seat.token || !seat.owner) continue;              // nobody holds it — nothing to cover
        if (autoCovered.has(key(match.id, seat.owner))) continue;
        if (manuallyCovered.has(key(match.id, seat.owner))) continue;
        const idle = lobby.seatIdleMs(match.id, seatIndex, nowMs);
        if (idle === null || idle < idleMs) continue;
        await coverSeat(match.id, seatIndex, seat.owner, idle);
      }
    }
  }

  /**
   * This seat's holder just made a call. Hands control back if — and only if — WE took it away.
   * Called from the same chokepoint that records presence (server/mcpSeatHandle.js's withSeat, via
   * tools/serve.js's wrapper), so returning is never a separate step an agent has to know about.
   */
  function onSeatActive(matchId, seatIndex) {
    const owner = lobby.getMatch(matchId)?.seats[seatIndex]?.owner;
    if (!owner || !autoCovered.delete(key(matchId, owner))) return;
    const bridge = getBridge(matchId);
    logEvent("agentSeatIdleReturn", { matchId, seat: owner });
    bridge?.setSeatAi?.(owner, false, {});
  }

  /** The agent asked for AI cover itself (or asked for it back) — see this file's own header. */
  function setManual(matchId, owner, wantAi) {
    if (wantAi) {
      manuallyCovered.add(key(matchId, owner));
      // An explicit request supersedes cover we had already applied — from here on it is the
      // agent's decision to reverse, not ours.
      autoCovered.delete(key(matchId, owner));
    } else {
      manuallyCovered.delete(key(matchId, owner));
      autoCovered.delete(key(matchId, owner));
    }
  }

  /** Whether this seat is currently covered because it went quiet (not because it asked to be). */
  function isAutoCovered(matchId, owner) {
    return autoCovered.has(key(matchId, owner));
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { sweep().catch(() => {}); }, checkEveryMs);
    // Never hold the process open on this alone: a server with nothing else running should still
    // exit, and every test that forgets to stop() should still finish.
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, sweep, onSeatActive, setManual, isAutoCovered, idleMs };
}
