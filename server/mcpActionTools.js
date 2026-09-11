/* ============================================================
   T-053 (FR-15): action tools — mapped directly onto the Phase 2 wire codec
   (net/commandEnvelope.js's encode/net/commandCodec.js), never a second, parallel command path.
   ONE tool, `issue_command`, whose `command` argument IS a WireCommand (net/commandShapes.js's
   own documented union) — the same shape input.js/inputCommands.js already build for a human
   player, and the ONLY wire shape server/matchWorker.js's own admit()/stepMatch ever accepts.
   "Validation identical to a human's" (this task's own exit criterion) follows from that
   directly: an agent's command goes through the EXACT SAME ownership/fog/rate-limit checks
   (net/commandCodec.js) as a real WebSocket connection's, because it IS the same codec, reached
   the same way (server/mcpCommandBridge.js's sendCommand mirrors net/wsWorkerTransport.js's own
   worker.postMessage({type:"command", seat, envelope}) exactly).

   "Batched, group-oriented" (this task's own row title) is likewise not new work here: every
   WireCommand's own `ids` array already holds 1..400 unit ids (net/commandShapes.js), and
   `{t:"batch", c:[...]}` already applies up to 16 commands together at one tick — a single
   `issue_command` call inherits both for free by construction, not by anything this file adds.

   Deliberately ONE flexible tool rather than ~20 narrow ones (move_units, attack_units, ...):
   the wire command union is large and already fully specified/documented/tested elsewhere
   (net/commandShapes.js, net/commandCodec.js's own test suite) — wrapping each variant in its
   own MCP tool would just be that same union spelled out 20 different ways, all converging on
   the identical bridge call underneath.

   T-056 (§6.3, ADR-0007): every issue_command call is now also gated by a published APM ceiling
   (net/agentApm.js) BEFORE it ever reaches the bridge/worker — safe to apply unconditionally,
   with no seat/controller-kind check at all, because this tool is the ONLY path that ever reaches
   this code: a real human's browser client plays over the WebSocket transport and never calls an
   MCP tool, so this can never rate-limit a human by mistake (see net/agentApm.js's own header for
   why the gate lives here, transport-side, rather than inside engine State the way the scripted
   AI's own aiApm mechanism does).
   ============================================================ */

"use strict";

import { withSeat, rejection, requirePlayingSeat } from "./mcpSeatHandle.js";
import { hintForCode } from "../net/refusalHints.js";

const COMMAND_SCHEMA = {
  type: "object",
  description:
    "A WireCommand (net/commandShapes.js). The discriminator field `t` selects the shape; " +
    "common ones: {t:'move',ids,x,y,q?}, {t:'attackMove',ids,x,y,q?}, {t:'attack',ids,target,q?}, " +
    "{t:'gather',ids,node,q?}, {t:'stop',ids}, {t:'hold',ids}, {t:'build',worker,b,x,y}, " +
    "{t:'build',worker,b,near:{x,y}} (the server picks the nearest LEGAL spot to `near` and tells you which — " +
    "prefer this to guessing x/y and being refused with invalid-placement), " +
    "{t:'queueProduction',building,u,alt?}, {t:'cancelProduction',building,i}, " +
    "{t:'setRally',building,x,y} (where a producer's new units walk to — set it before a fight " +
    "rather than moving each spawn by hand), {t:'researchTech',building,tech}. " +
    "Workers cannot attack: use {t:'build',...}/{t:'gather',...} for them. " +
    "`ids` is an array of 1-400 unit/building ids you own. Wrap several commands in " +
    "{t:'batch',c:[...]} (max 16) to apply them together at the same tick.",
  properties: { t: { type: "string" } },
  required: ["t"],
};

/**
 * @param {Object} lobby a createLobby() instance
 * @param {(matchId:string) => {sendCommand:(seat:string,cmd:Object)=>Promise<Object>}|null} getBridge
 *   looks up a LIVE match's own command bridge by id (tools/serve.js's own liveMatches) — null
 *   for a match that hasn't started yet, the same shape server/mcpObservationTools.js's own
 *   getCache uses for the identical reason (many concurrent matches, each its own worker).
 * @param {(matchId:string) => {tryConsume:(owner:string,nowMs:number)=>boolean}|null} [getApmGuard]
 *   looks up a LIVE match's own APM guard by id (net/agentApm.js's createAgentApmGuard, one per
 *   match, the same routing shape as getBridge/getCache for the identical reason). Defaults to
 *   "no guard anywhere" (unthrottled) — the same graceful-degradation default
 *   engine/aiCommon.js's own apm==null already uses — so every caller/test built before T-056
 *   keeps working unchanged.
 */
/**
 * @param {(matchId:string, owner:string, wantAi:boolean) => void} [onSeatControllerSet] told about
 *   every EXPLICIT handover, so server/seatPresence.js's own idle cover can tell "the agent asked
 *   for this" apart from "we did it because the seat went quiet" — the two must not undo each
 *   other (see that file's own header). Defaults to a no-op for every caller that has no presence
 *   tracking at all.
 */
export function createActionTools(lobby, getBridge, getApmGuard = () => null, onSeatControllerSet = () => {}, seatMemory = null) {
  return [
    {
      name: "issue_command",
      title: "Issue a unit/building/production command",
      description:
        "Submits a command for the calling seat's own units/buildings — the same wire command " +
        "a human player's client sends, validated by the identical server-side codec (ownership, " +
        "fog, affordability, rate limits). A rejected command reports the same machine-readable " +
        "reject code a human's own rejected click would get — plus a `hint` saying what actually " +
        "blocked it and what to do instead (which building is missing, how much ore you are short, " +
        "why the placement failed), so you can adjust and retry. Subject " +
        "to a published actions-per-minute ceiling — a burst of calls beyond that budget is " +
        "rejected the same way, not silently queued.",
      inputSchema: {
        type: "object",
        properties: { seat_handle: { type: "string" }, command: COMMAND_SCHEMA },
        required: ["seat_handle", "command"],
      },
      handler: withSeat(lobby, async ({ seat, command }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet — wait_for_event until every seat is filled, then re-issue");
        const apmGuard = getApmGuard(seat.matchId);
        if (apmGuard && !apmGuard.tryConsume(seat.owner, Date.now())) {
          // Says what to do about it AND how long it will be: an agent that only hears "too fast"
          // has to guess whether to retry in a second or a minute.
          const left = apmGuard.remaining?.(seat.owner, Date.now());
          return rejection(`agent-apm-exceeded: you are issuing commands faster than this match's actions-per-minute budget — pace your orders, or batch several into one command${left ? `, and retry in ~${left.seconds_until_next}s (cap ${left.cap})` : ", and retry in a few seconds"}`);
        }
        // `near` is resolved to a real, legal x/y BEFORE the command is submitted — using the
        // engine's own placement search inside the worker, never a second copy of the rule out
        // here. A recorded match burned three commands and ~15 seconds hunting for a legal turret
        // spot by hand, at the exact moment the turret was the thing that would have saved it.
        let chosenSite = null;
        let outgoing = command;
        if (command && command.t === "build" && command.near && typeof command.near === "object") {
          if (!bridge.findBuildSite) return rejection("near-unsupported: this match's server cannot search for a site — pass x/y instead");
          const { site } = await bridge.findBuildSite(command.b, command.near.x, command.near.y);
          if (!site) return rejection("no-legal-site: nowhere near that point can hold this building — try a different area");
          chosenSite = site;
          const { near, ...rest } = command;
          outgoing = { ...rest, x: site.x, y: site.y };
        }
        const result = await bridge.sendCommand(seat.owner, outgoing);
        // The budget AFTER this call, on success and failure alike: an agent could previously only
        // discover its ceiling by being refused, which makes "fire and find out" the cheapest
        // strategy — exactly the behaviour the ceiling exists to discourage.
        const budget = apmGuard?.remaining?.(seat.owner, Date.now()) ?? null;
        const apm = budget ? { apm_remaining: budget.actions, apm_cap: budget.cap, ...(budget.seconds_until_next ? { seconds_until_next_action: budget.seconds_until_next } : {}) } : {};
        if (result.ok) {
          return {
            content: [{ type: "text", text: `Command applied.${chosenSite ? ` Building site chosen at (${chosenSite.x}, ${chosenSite.y}).` : ""}` }],
            structuredContent: { ...(result.result ?? {}), ...(chosenSite ? { site: chosenSite } : {}), ...apm },
          };
        }
        const detail = result.reason ? `${result.code} (${result.reason})` : result.code;
        // Two halves of the same answer, and neither replaces the other: the `hint` says what to DO
        // about the rule that said no ("requires a completed Foundry — build one first"), while
        // `detail` carries the NUMBERS behind it from the worker, which is the only place that can
        // see them (server/matchWorker.js's explainResult) — what it costs, what you have, what you
        // are short, and when your measured income covers it. An agent that gets only a code
        // guesses and re-sends the identical command; one that gets only the hint still cannot tell
        // "wait six seconds" from "never on this economy".
        const hint = result.hint || hintForCode(result.code);
        const numbers = result.detail ?? null;
        // The hint already says the shortfall and the fix in words ("you need 20 more Ore…",
        // "supply is capped — build a Habitat"), so the text adds only what it cannot: WHEN this
        // seat's measured income covers it, and the site that would have worked. The full numbers
        // are in `detail` regardless, for a caller that wants to compute with them.
        const numbersText = numbers
          ? `${numbers.seconds_until_affordable !== undefined ? ` Affordable in ~${numbers.seconds_until_affordable}s at your current income.` : ""}${numbers.nearest_legal_site ? ` Nearest legal site: (${numbers.nearest_legal_site.x}, ${numbers.nearest_legal_site.y}).` : ""}`
          : "";
        return {
          content: [{ type: "text", text: `Command rejected: ${detail} — ${hint}${numbersText}` }],
          isError: true,
          structuredContent: { code: result.code, ...(result.reason ? { reason: result.reason } : {}), hint, ...(numbers ? { detail: numbers } : {}), ...apm },
        };
      }),
    },
    {
      // T-059a (FR-8): the real network trigger for engine/victory.js's own surrender() — a
      // seat-level concession, never a WireCommand (no ids, no ownership/fog/affordability to
      // check, no INPUT_DELAY_TICKS scheduling — none of issue_command's own codec applies to
      // "I am ending my own participation"), so this is its own tool rather than a new `t` on
      // COMMAND_SCHEMA's union.
      name: "surrender",
      title: "Surrender the match",
      description:
        "Voluntarily ends the calling seat's own participation in a live match — the same " +
        "concession a human player's in-match surrender action performs. Irreversible: once sent, " +
        "this seat is eliminated and cannot rejoin this match. Not instant: engine/victory.js's " +
        "own surrender only marks the seat eliminated, so the match's own over/winner/winReason " +
        "resolve on the very next tick, not this call — check get_situation or wait_for_event " +
        "afterward to see the outcome. Before a match has started, use leave_match instead.",
      inputSchema: {
        type: "object",
        properties: { seat_handle: { type: "string" } },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, async ({ seat }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet — leave_match instead");
        // Take the seat back from the scripted AI first, if a set_seat_controller handover left it
        // there: server/matchWorker.js's own surrender handler deliberately ignores a request for a
        // seat a controller is driving (a scripted AI has no MCP handle to send one from, so such a
        // message could only be stray), which would otherwise make "hand my seat to the AI, then
        // concede" silently do nothing. A no-op for a seat that was never handed over.
        if (bridge.setSeatAi) await bridge.setSeatAi(seat.owner, false);
        bridge.surrender(seat.owner);
        return { content: [{ type: "text", text: "Surrendered. Your participation in this match has ended." }] };
      }),
    },
    {
      // The explicit handover an MCP client needs and a browser client does not. A human's browser
      // holds a live WebSocket, so the server can SEE them step away (the socket closes) and hand
      // their seat to the game's own AI after a grace period, handing it straight back when they
      // reconnect (server/matchWorker.js's seatDisconnected/seatConnected). An MCP client has no
      // such socket — it speaks in one-shot tool calls, and going quiet for two minutes to compact
      // its context is indistinguishable from thinking hard. So it says so instead: this is the
      // same one-line controller swap on the same slot, just requested rather than inferred.
      name: "set_seat_controller",
      title: "Hand your seat to the AI, or take it back",
      description:
        "Decides who drives YOUR seat right now. controller:'ai' hands it to one of the game's own " +
        "built-in opponents (optionally naming ai_strategy/difficulty) — do this before any pause " +
        "long enough to matter (compacting your context, a restart, a long think) so your base keeps " +
        "building and defending itself instead of standing still while the match runs on. " +
        "controller:'self' takes it back, and your commands work again immediately. Reversible as " +
        "often as you like, and your seat_handle and client_id stay valid throughout — this is not " +
        "leaving the match. Whatever the AI did while it held the seat stands; call get_situation " +
        "when you return rather than assuming the position you left.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          controller: { type: "string", enum: ["ai", "self"], description: "'ai' = the game's own AI plays this seat until further notice; 'self' = you are playing it again." },
          ai_strategy: { type: "string", description: "Only with controller:'ai' — which built-in strategy it should play (default, aggressive, economic, matching). Unknown names fall back to the default." },
          difficulty: { type: "string", description: "Only with controller:'ai' — easy, medium or hard." },
        },
        required: ["seat_handle", "controller"],
      },
      handler: withSeat(lobby, async ({ seat, controller, ai_strategy, difficulty }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        if (controller !== "ai" && controller !== "self") return rejection("bad-controller: use 'ai' or 'self'");
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet");
        if (!bridge.setSeatAi) return rejection("handover-unsupported: this match's server cannot swap a seat's controller");
        const wantAi = controller === "ai";
        // Recorded BEFORE the swap, so an idle sweep landing between these two lines can never
        // see a seat as un-owned-by-the-agent and re-cover what the agent just took back.
        onSeatControllerSet(seat.matchId, seat.owner, wantAi);
        const { ai } = await bridge.setSeatAi(seat.owner, wantAi, {
          ...(ai_strategy ? { strategy: ai_strategy } : {}),
          ...(difficulty ? { difficulty } : {}),
        });
        return {
          content: [{ type: "text", text: ai
            ? "The game's AI is playing your seat now. Call set_seat_controller with controller:'self' when you are ready to play again."
            : "You are driving your seat again. Call get_situation before acting — the position may have moved on." }],
          structuredContent: { controller: ai ? "ai" : "self", owner: seat.owner, ai_controlled: ai },
        };
      }),
    },
    {
      // ===== Standing production orders =====
      // The single highest-leverage thing this transport can offer an agent, and the one it most
      // conspicuously lacked. An agent's decision only holds until its next call; the sim ticks
      // twenty times a second in between. Both recorded matches show the same losing shape —
      // "keep making Bastions" decided, unaffordable at the instant it was decided, and by the
      // next look the window had closed. A plan spends on the agent's behalf, the moment the ore
      // lands, through the identical validated command path.
      name: "set_production_plan",
      title: "Keep producing these as resources allow",
      description:
        "A standing order: the server queues these units for you, at these buildings, as soon as you can afford each " +
        "one — so production never stalls in the gap between your calls. Each entry is " +
        "{building, unit, repeat, max_queued?}: repeat is how many MORE of that unit to make before the entry " +
        "retires (1-50), max_queued is how deep it will fill that building's queue (default 2, so a plan cannot " +
        "swallow the ore you were saving for a tech building). Every queue attempt goes through the same validation " +
        "and costs the same resources as your own issue_command would; nothing is queued while you cannot afford it, " +
        "are supply-capped, or lack the prerequisite. You get a planExhausted event when an entry runs out — renew it " +
        "then. Call with plan:[] or action:'clear' to stop, action:'list' to see what is still standing. " +
        "This does NOT replace deciding what to build; it replaces having to be awake at the instant you can pay for it.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          action: { type: "string", enum: ["set", "clear", "list"], description: "Default 'set'." },
          plan: {
            type: "array", maxItems: 8,
            items: {
              type: "object",
              properties: {
                building: { type: "string", description: "One of YOUR building ids (e.g. the barracks that will make these)." },
                unit: { type: "string", description: "Unit type to produce." },
                repeat: { type: "number", description: "How many more to make (1-50, default 1)." },
                max_queued: { type: "number", description: "Never let this building's queue exceed this many jobs (1-8, default 2)." },
                alt: { type: "boolean", description: "Pay the unit's alternative cost, where it has one." },
              },
              required: ["building", "unit"],
            },
          },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, async ({ seat, action, plan }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet");
        if (!bridge.setProductionPlan) return rejection("plans-unsupported: this match's server cannot hold a standing order");
        const verb = action === "clear" || action === "list" ? action : "set";
        const result = await bridge.setProductionPlan(seat.owner, verb, verb === "set" ? (plan ?? []) : []);
        if (result.plan === null) return rejection("plan-timeout: the match worker did not answer — try again");
        // Reported back in the same snake_case vocabulary the tool accepts, rather than the
        // worker's own internal field names — a caller should be able to feed a listed plan
        // straight back in.
        const live = result.plan.map(e => ({ building: e.building, unit: e.unit, remaining: e.remaining, max_queued: e.maxQueued, ...(e.alt ? { alt: true } : {}) }));
        return {
          content: [{ type: "text", text: live.length
            ? `Standing order: ${live.map(e => `${e.remaining}x ${e.unit} at ${e.building}`).join("; ")}. These are queued for you as resources allow.`
            : "No standing production order is active." }],
          structuredContent: { plan: live },
        };
      }),
    },
    {
      // ===== Turn-based pacing =====
      // The structural answer to the mismatch this whole file works around: a human clicks in
      // real time, an agent thinks for tens of seconds, and the sim does not care. In a match
      // created with clock_policy:'deliberation' the world does not advance until every agent in
      // it says it has finished its turn — so thinking is free, and a build order that takes 38
      // seconds of game time costs the same whoever is playing.
      name: "end_turn",
      title: "End your turn (deliberation matches only)",
      description:
        "In a match created with clock_policy:'deliberation', the world is FROZEN until every agent seat has called " +
        "this — then it advances one round and freezes again. Call it once you have issued everything you mean to " +
        "issue this turn, then read the result with take_turn or get_situation. It does nothing in an ordinary " +
        "realtime match, where the clock never waits for anyone (there, a long think costs you the game time it " +
        "took — use set_seat_controller if you need to step away). A seat that never calls it is not allowed to " +
        "stall the match forever: the server advances the round on its own watchdog.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, async ({ seat }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        const bridge = getBridge(seat.matchId);
        if (!bridge) return rejection("match-not-live: this match hasn't started yet");
        if (!bridge.endTurn) return rejection("end-turn-unsupported: this match's server cannot pace turns");
        bridge.endTurn(seat.owner);
        return {
          content: [{ type: "text", text: "Turn ended. The round advances once every other agent seat has ended its turn too (or the watchdog fires); read the result with take_turn." }],
          structuredContent: { ended: true, owner: seat.owner },
        };
      }),
    },
    {
      // ===== Seat memory =====
      // See server/mcpSeatMemory.js for why the SERVER holds a few kilobytes of the agent's own
      // notes: a match outlives a context window, and a plan that is no longer in context is a
      // plan the agent is no longer playing.
      name: "remember",
      title: "Write or read your own notes for this seat",
      description:
        "A few kilobytes of private scratch memory tied to THIS SEAT, which survives anything that happens to your " +
        "context: a compaction, a restart, a lost handle you recovered with reclaim_seat. Pass `notes` to overwrite " +
        "what is stored; call it with no notes to read back what you wrote. Keep your plan here — the build you " +
        "committed to, the trigger you are waiting for, what you learned about the opponent — and re-read it when you " +
        "come back, rather than re-deriving it from the board. Nobody else can read it, it is gone when the match " +
        "ends, and it has no effect on the game.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          notes: { type: "string", description: "The text to store, replacing whatever was there. Omit to read." },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, ({ seat, notes }) => {
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        if (!seatMemory) return rejection("memory-unsupported: this server holds no seat memory");
        if (notes === undefined) {
          const stored = seatMemory.read(seat.matchId, seat.owner);
          return {
            content: [{ type: "text", text: stored.notes === null ? "Nothing stored for this seat yet." : stored.notes }],
            structuredContent: stored,
          };
        }
        const written = seatMemory.write(seat.matchId, seat.owner, notes);
        if (!written.ok) return rejection(written.code);
        return {
          content: [{ type: "text", text: `Stored ${written.bytes} bytes for this seat.` }],
          structuredContent: { stored_bytes: written.bytes },
        };
      }),
    },
  ];
}
