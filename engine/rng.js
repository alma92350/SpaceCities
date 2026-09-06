// @ts-check
/* ============================================================
   The sim's one sanctioned source of randomness: a small, fast, seedable
   PRNG. Passing a mulberry32(seed) into createGameState makes a whole match
   reproducible from that one number — the foundation for shareable map seeds
   today and replays/netcode later. The engine uses NO other randomness (a
   determinism-guard test enforces it), so "same seed ⇒ same game".
   ============================================================ */

"use strict";

// A tiny deterministic string hash (the classic h=7, h*31+c), used across the sim for stable
// per-id / per-pair tie-breaks — a worker's orbit angle, an avoidance dodge direction, a
// spread-fire target pick. It lived, byte-identical, in four separate modules; centralised here
// (the natural home for deterministic number sources) so a change can't drift between copies.
// All ids are ASCII, so this is exact; >>> 0 keeps it an unsigned 32-bit int.
/**
 * @param {string} s an entity id, or any ASCII key worth a stable tie-break
 * @returns {number} an unsigned 32-bit hash
 */
export function hashStr(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// mulberry32: 32-bit state, good distribution, identical output across JS
// engines for the same seed. Returns a function producing floats in [0, 1).
/**
 * @param {number} seed
 * @returns {() => number} a function producing floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
