/* ============================================================
   Central JSDoc type definitions for the command wire shape — the format a
   player action takes between a client and a session, in EVERY mode this game
   runs in: single-player over the in-process loopback transport (Phase 1),
   and eventually multiplayer over a real socket (Phase 3).

   This file has NO runtime code, exactly like engine/types.js, and for the
   same reason: it exists purely so `// @ts-check` files (and any editor with
   the bundled TypeScript language service) can check against a shared,
   accurate model instead of an untyped `any` bag. Because it declares no
   imports/exports it is a *script*, so these @typedefs are GLOBAL — every
   file in the project can refer to `WireCommand`, `Ids`, … by name with no
   import, exactly like the engine/ shapes.

   WHY THIS SHAPE, THIS EARLY. ADR-0004's decision is "same command encoding"
   for single-player and multiplayer — not two formats that converge later.
   So the wire shape is designed once, in docs/analysis/02-command-wire-protocol.md
   §3, and adopted here VERBATIM for the commands ordinary skirmish play needs
   — even though nothing on the loopback transport (Phase 1) actually needs a
   compact/serializable format yet. Phase 2's net/commandCodec.js layers
   ownership/fog/rate-limit VALIDATION on top of exactly this shape; it does
   not redesign it. Getting the shape right now is what makes that additive
   rather than a rewrite.

   SCOPE. This union covers ordinary skirmish play — every command
   `inputCommands.js`/`input.js`/`hudSelection.js` issue for a 1v1 (soon N-seat)
   match: unit orders (engine/commands.js's full issue* surface) plus
   production and research (engine/production.js, engine/techtree.js), which
   are core skirmish mechanics, not Odyssey extras.

   DELIBERATELY EXCLUDED, for now. Odyssey-only mutators — engine/galaxy.js
   (jump/lanes/Spaceport/capital ships), engine/colonyPolicy.js,
   engine/colony.js (deploy/pack), engine/market.js, engine/diplomacy.js.
   Odyssey is explicitly out of the multiplayer story (PRD §4 non-goals) and
   stays on its current direct-engine-call path; porting it onto this seam,
   if ever wanted, is separate follow-on work (TASKS.md T-012a), not a gap in
   this file.
   ============================================================ */

"use strict";

/** engine/formation.js FORMATION_SHAPES / LEADER_POSITIONS — the only legal values. */
/** @typedef {"grid"|"line"|"wedge"|"circle"} Shape */
/** @typedef {"front"|"back"|"center"} LeadPos */

/**
 * Rides on move / attackMove. Maps to engine/commands.js's `formation` opts bag.
 * originX/originY are NOT here — issueHoldFormation derives them from the live
 * centroid server-side (commands.js:377-380).
 * @typedef {Object} WireFormation
 * @property {Shape} [s] - shape; default "grid"
 * @property {LeadPos} [l] - leaderPos; default "front"
 * @property {number} [hx] - headingX, the right-click-drag vector (world-space, not normalized)
 * @property {number} [hy] - headingY
 */

/** Ordered, de-duplicated entity ids. ORDER IS LOAD-BEARING — see engine/commands.js:105,
 *  145, 195, 363: ids[0] is the formation leader, and issueEscort derives ring slots from
 *  array position. Never sort, canonicalise, or reorder. 1..400 entries.
 *  @typedef {string[]} Ids */

/**
 * @typedef {Object} MoveCommand
 * @property {"move"} t
 * @property {Ids} ids
 * @property {number} x
 * @property {number} y
 * @property {boolean} [q] - queue (Ctrl-modifier); appends as a waypoint instead of replacing
 * @property {WireFormation} [f]
 */
/** @typedef {Object} AttackMoveCommand
 * @property {"attackMove"} t @property {Ids} ids @property {number} x @property {number} y
 * @property {boolean} [q] @property {WireFormation} [f] */
/** @typedef {Object} HoldFormationCommand
 * @property {"holdFormation"} t @property {Ids} ids @property {Shape} [s] @property {LeadPos} [l] */
/** @typedef {Object} PatrolCommand
 * @property {"patrol"} t @property {Ids} ids
 * @property {Array<{x: number, y: number}>} pts - 1..32 points */
/** @typedef {Object} StopCommand @property {"stop"} t @property {Ids} ids */
/** @typedef {Object} HoldCommand @property {"hold"} t @property {Ids} ids */
/** @typedef {Object} ScoutCommand @property {"scout"} t @property {Ids} ids */

/** @typedef {Object} AttackCommand
 * @property {"attack"} t @property {Ids} ids @property {string} target @property {boolean} [q] */
/** @typedef {Object} EscortCommand
 * @property {"escort"} t @property {Ids} ids @property {string} target @property {boolean} [q] */
/** @typedef {Object} RepairCommand
 * @property {"repair"} t @property {Ids} ids @property {string} target @property {boolean} [q] */
/** @typedef {Object} GatherCommand
 * @property {"gather"} t @property {Ids} ids @property {string} node @property {boolean} [q] */
/** @typedef {Object} ServiceCommand - assign workers to service a building's logistics
 * @property {"service"} t @property {Ids} ids @property {string} target @property {boolean} [q] */
/** @typedef {Object} FerryCommand - assign workers to ferry a friendly freighter
 * @property {"ferry"} t @property {Ids} ids @property {string} target @property {boolean} [q] */
/** @typedef {Object} SetHomeBaseCommand
 * @property {"setHomeBase"} t @property {Ids} ids @property {string} target */
/** @typedef {Object} AssistBuildCommand - no buildingType: the session reads it off the resolved site
 * @property {"assistBuild"} t @property {Ids} ids @property {string} target @property {boolean} [q] */

/** @typedef {Object} BuildCommand
 * @property {"build"} t @property {string} worker @property {string} b @property {number} x @property {number} y */
/** @typedef {Object} RecycleCommand - units AND buildings
 * @property {"recycle"} t @property {Ids} ids */
/** @typedef {Object} CancelRecycleCommand
 * @property {"cancelRecycle"} t @property {Ids} ids */

/** @typedef {Object} SetAILogisticsCommand
 * @property {"setAILogistics"} t @property {Ids} ids @property {boolean} on */
/** @typedef {Object} SetCollectPointCommand
 * @property {"setCollectPoint"} t @property {Ids} ids @property {boolean} on */
/** @typedef {"high"|"normal"|"low"} LogiPriority - engine/haul.js LOGI_PRIORITIES */
/** @typedef {Object} SetLogiPriorityCommand
 * @property {"setLogiPriority"} t @property {string} building @property {LogiPriority} p */
/** @typedef {Object} SetRallyCommand
 * @property {"setRally"} t @property {string} building @property {number} x @property {number} y
 * @property {string|null} [node] */

/** Skirmish-essential economy: every match builds units and researches doctrines.
 *  @typedef {Object} QueueProductionCommand
 * @property {"queueProduction"} t @property {string} building @property {string} u
 * @property {boolean} [alt] - engine/production.js's alt-recipe flag */
/** @typedef {Object} CancelProductionCommand
 * @property {"cancelProduction"} t @property {string} building @property {number} i - queue index */
/** @typedef {Object} ResearchUpgradeCommand - a Refinery doctrine tier (engine/production.js)
 * @property {"researchUpgrade"} t @property {string} building @property {string} up */
/** @typedef {Object} ResearchTechCommand - a Foundry/Datacenter tech (engine/techtree.js)
 * @property {"researchTech"} t @property {string} building @property {string} tech */
/** @typedef {Object} CancelResearchCommand
 * @property {"cancelResearch"} t @property {string} building @property {number} i */
/** @typedef {Object} LightFuseCommand - arm a Helium Bomb (engine/bomb.js)
 * @property {"lightFuse"} t @property {string} unit */

/** @typedef {MoveCommand|AttackMoveCommand|HoldFormationCommand|PatrolCommand|StopCommand
 *   |HoldCommand|ScoutCommand|AttackCommand|EscortCommand|RepairCommand|GatherCommand
 *   |ServiceCommand|FerryCommand|SetHomeBaseCommand|AssistBuildCommand|BuildCommand
 *   |RecycleCommand|CancelRecycleCommand|SetAILogisticsCommand|SetCollectPointCommand
 *   |SetLogiPriorityCommand|SetRallyCommand|QueueProductionCommand|CancelProductionCommand
 *   |ResearchUpgradeCommand|ResearchTechCommand|CancelResearchCommand|LightFuseCommand
 *   |BatchCommand} WireCommand */

/** Deliberately NOT nested — Phase 2's codec rejects a batch inside a batch.
 *  1..16 members, applied in array order, at one tick.
 *  @typedef {Object} BatchCommand
 * @property {"batch"} t @property {WireCommand[]} c */

/**
 * What a session hands back after applying a command — the loopback transport's
 * synchronous return value in Phase 1; a "commandResult" event over the wire
 * once a real socket exists (Phase 3).
 * @typedef {Object} CommandResult
 * @property {boolean} ok
 * @property {string} [code] - a REJECT.* reason when ok is false (see net/commandCodec.js, Phase 2)
 * @property {Object} [result] - an echo for build-like commands, e.g. { buildingId }
 */
