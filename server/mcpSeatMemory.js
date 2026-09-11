/* ============================================================
   Agent-observability: a few kilobytes of scratch memory attached to a SEAT, readable and
   writable only through that seat's own handle.

   WHY THE SERVER HOLDS THIS AT ALL, when the caller obviously has memory of its own: an MCP
   agent's only memory is its context window, and a long match outlives one. Two recorded matches
   show both failure shapes — an agent that had written down the right plan at 40s ("mass
   bastions, foundry the moment they show one") and was no longer reasoning against it at 180s,
   and an agent whose seat handle expired mid-match and came back through reclaim_seat with
   nothing but what it could re-derive from the board. A plan, a trigger it is waiting for, the
   position it last decided to hold — none of that is recoverable from a projection, because none
   of it is in the world; it is in whatever the agent was thinking a hundred tool calls ago.

   Deliberately NOT engine state and NOT in the snapshot: it never touches the sim, never reaches
   another seat (a spectator included), and a match that ends takes it with it. That also makes it
   fog-irrelevant by construction — a seat can only ever read back what that same seat wrote.
   ============================================================ */

"use strict";

// Bounded on both axes: enough for a plan, a checklist and a few remembered positions, never
// enough to be used as free server-side storage by a caller that has stopped playing.
export const MEMORY_MAX_BYTES = 8192;
const MAX_SEATS = 512;

/**
 * @returns {{
 *   read: (matchId: string, owner: string) => {notes: string|null, updated_tick: number|null},
 *   write: (matchId: string, owner: string, notes: string, tick?: number|null) => {ok: true, bytes: number}|{ok: false, code: string},
 *   forget: (matchId: string) => void,
 * }}
 */
export function createSeatMemory() {
  /** @type {Map<string, {notes: string, tick: number|null}>} */
  const bySeat = new Map();
  // A match id is a uuid and an owner id is a short lowercase word, so neither can contain the
  // separator — no escaping needed, and no way for one seat's key to spell another's.
  const key = (matchId, owner) => `${matchId}|${owner}`;

  return {
    read(matchId, owner) {
      const entry = bySeat.get(key(matchId, owner));
      return { notes: entry?.notes ?? null, updated_tick: entry?.tick ?? null };
    },
    write(matchId, owner, notes, tick = null) {
      const text = String(notes ?? "");
      const bytes = Buffer.byteLength(text, "utf8");
      // Refused rather than truncated: a silently clipped plan is worse than no plan, because the
      // caller goes on believing it wrote what it wrote.
      if (bytes > MEMORY_MAX_BYTES) return { ok: false, code: `memory-too-large: ${bytes} bytes, limit ${MEMORY_MAX_BYTES}` };
      const k = key(matchId, owner);
      if (!bySeat.has(k) && bySeat.size >= MAX_SEATS) {
        // Oldest insertion first — Map preserves it, and a seat still playing rewrites its own
        // entry often enough that eviction lands on abandoned matches long before live ones.
        bySeat.delete(bySeat.keys().next().value);
      }
      bySeat.set(k, { notes: text, tick: Number.isFinite(tick) ? tick : null });
      return { ok: true, bytes };
    },
    forget(matchId) {
      for (const k of [...bySeat.keys()]) if (k.startsWith(`${matchId}|`)) bySeat.delete(k);
    },
  };
}
