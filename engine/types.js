/* ============================================================
   Central JSDoc type definitions for the core sim shapes.

   This file has NO runtime code — it is never imported and never loaded by the
   browser or by node. It exists purely so `// @ts-check` files (and any editor
   with the bundled TypeScript language service) can type-check against a shared,
   accurate model of the game state instead of an untyped `any` bag. Because the
   file declares no imports/exports it is a *script*, so these @typedefs are
   GLOBAL — every file in the project can refer to `State`, `Unit`, `Building`,
   … by name without importing anything.

   The shapes here mirror the real runtime literals (engine/state.js factories,
   engine/galaxy.js, engine/map.js). Keep them in sync: when a factory grows a
   field, add it here. Fields attached dynamically after construction (the
   broad-phase grid, the Odyssey market/diplomacy, transient flags) are marked
   optional so both the constructing literal and the later-attaching code check.
   ============================================================ */

"use strict";

// ---- primitives / small records -------------------------------------------------

/**
 * A commodity ledger: commodity id → amount. Always carries ore/crystals/radioactives;
 * an Odyssey world's market adds the tradeable goods (gas, ice, biomass, spice, …).
 * @typedef {Object.<string, number>} Resources
 */

/**
 * A worker's carried load.
 * @typedef {Object} Cargo
 * @property {string|null} com   commodity id being carried, or null when empty
 * @property {number} qty        amount carried
 */

/**
 * A unit order. `type` is always present; the rest depend on the order kind
 * (move/gather/attack/attack-move/build/escort/scout/hold-formation/follow-leader).
 * @typedef {Object} Order
 * @property {string} type
 * @property {number} [x]
 * @property {number} [y]
 * @property {string} [targetId]
 * @property {string} [nodeId]
 * @property {string} [buildingId]
 * @property {string} [freighterId]  ferry: the specific landed freighter a worker is assigned to load/unload (engine/haul.js updateFerry)
 * @property {string} [com]
 * @property {number} [slot]
 * @property {number} [slots]
 * @property {string} [phase]
 * @property {boolean} [manual]   a player-assigned service/ferry order sticks to its building/freighter (engine/haul.js)
 * @property {boolean} [aiJob]    haul/service: this order was auto-assigned to an AI-logistics freighter, not a worker — bills AI Cores upkeep (engine/sim.js, engine/haul.js payAIUpkeep)
 * @property {number} [anchorX]   hold-formation: this unit's own fixed anchor point (engine/commands.js issueHoldFormation)
 * @property {number} [anchorY]
 * @property {number} [offsetX]   hold-formation/follow-leader: this unit's fixed offset from the anchor/leader (engine/formation.js)
 * @property {number} [offsetY]
 * @property {Unit} [leader]      follow-leader: the formation leader this unit is chasing (engine/movement.js keepFollowingLeader) — a live object reference, NEVER persisted (engine/persist.js drops a follow-leader order entirely on save)
 * @property {number} [speedCap]  move/attack-move/hold-formation/scout: a formation leader's travel speed, capped to its slowest member (engine/movement.js orderedSpeed)
 * @property {number} [tx]        scout: the current leg's destination (engine/scout.js updateScoutMode) — distinct from x/y, which a scout order doesn't use
 * @property {number} [ty]
 * @property {boolean} [explore]  scout: this leg is heading for genuinely unexplored ground (vs. a patrol circuit leg)
 * @property {boolean} [patrol]   patrol: requeue-me flag (engine/commands.js issuePatrol), read off orderQueue by engine/sim.js
 * @property {number} [patrolLeg] scout: index into scout.js's PATROL circuit, once nothing is left to discover. Deliberately NOT named `patrol` — see that field
 */

/**
 * A world's opponent temperament (engine/aiArchetypes.js). Loosely typed — only the
 * fields the sim actually reads are pinned.
 * @typedef {Object} Archetype
 * @property {string} [name]
 * @property {string[]} [unitMix]
 * @property {number} [attackTimeout]
 * @property {number} [workerTarget]
 * @property {number} [armyAttackSize]
 * @property {string} [faction]
 * @property {Object} [odyssey]
 * @property {number} [turretCount]     how much static defense this temperament wants (engine/aiEconomy.js)
 * @property {number} [maxBarracks]     cap on production buildings (engine/aiEconomy.js)
 * @property {number} [garrison]        home guard held back from a push (engine/aiMilitary.js withoutHomeGuard)
 * @property {boolean} [wantsRefinery]  patient enough to bank for a Refinery and research its doctrine (engine/aiEconomy.js)
 */

/**
 * A player-picked AI strategy (engine/aiStrategy.js) — orthogonal to the Archetype, an
 * aggression overlay rather than a flavor one. Loosely typed, like Archetype: only the
 * fields the sim actually reads are pinned, and every one is optional (STRATEGIES.default
 * has none set at all).
 * @typedef {Object} Strategy
 * @property {string} [name]
 * @property {string} [desc]
 * @property {number} [attackTimeoutMult]
 * @property {number} [armyAttackSizeMult]
 * @property {number} [garrisonMult]
 * @property {number} [turretCountMult]
 * @property {number} [workerTargetMult]
 * @property {number} [graceMult]              Odyssey diplomacy grace window (engine/diplomacy.js)
 * @property {number} [grievanceMult]          Odyssey diplomacy grievance/creep (engine/diplomacy.js)
 * @property {boolean} [neverInitiates]        never volunteers a wave off army size / hostility
 * @property {number} [standingArmyCap]        Economic's minimal peacetime army-production cap
 * @property {number} [warFootingMult]         cap multiplier while ctx.warFooting is true
 * @property {number} [warFootingTime]         seconds a seen threat keeps warFooting active
 * @property {boolean} [matchEnemyForce]       Force Parity: track the enemy's seen strength instead of a fixed cap
 * @property {number} [matchBuffer]
 * @property {number} [matchFloor]
 * @property {boolean} [wantsIndustryAlways]   climbs the deep factory chain regardless of archetype.wantsRefinery
 * @property {boolean} [useBombOffensively]    walks a built Helium Bomb to the attack target instead of leaving it home
 * @property {number} [punishPosture]         adaptation: at or below this enemy posture, punish greed (engine/aiIntel.js)
 * @property {number} [punishConfidence]      adaptation: evidence required before acting on that read
 * @property {number} [adaptRateMult]         adaptation: multiplier on how fast the stance moves
 * @property {number} [adaptBandMult]         adaptation: multiplier on the dead band that resists moving it
 * @property {number} [defenceSwingMult]      adaptation: multiplier on how far the stance swings static defence
 */

// ---- entities -------------------------------------------------------------------

/**
 * A mobile unit (engine/state.js makeUnit). The first block is the constructed shape;
 * the optional tail is state attached later by the sim (grid index, combat targeting).
 * @typedef {Object} Unit
 * @property {"unit"} kind
 * @property {string} id
 * @property {string} type
 * @property {string} owner
 * @property {number} x
 * @property {number} y
 * @property {number} hp
 * @property {number} maxHp
 * @property {Order|null} order
 * @property {Order[]} orderQueue
 * @property {Cargo|null} cargo
 * @property {number} attackTimer
 * @property {string|null} autoTarget
 * @property {number} [lastHitAt]     state.time this unit last took damage (engine/combat.js performAttack/applySplash) — read by the Bulwark doctrine's out-of-combat regen (engine/repair.js updateBulwarkRegen, gated on upgrades.reinforcedBulwark/selfSealingPlating); absent reads as "never hit" (repair.js falls back to 0)
 * @property {number} [_gi]           transient broad-phase index, re-stamped each tick (grid.js)
 * @property {string|null} [focusId]  AI focus-fire target (ai.js / combat.js)
 * @property {boolean} [hold]         hold-stance flag (combat.js)
 * @property {boolean} [autoRepair]   a Mender set to roam and mend damaged friendlies on its own (engine/sim.js)
 * @property {string|null} [repairTargetId]  transient: the friendly an auto-repair Mender is committed to (engine/sim.js)
 * @property {string|null} [targetId] aim target (combat.js / render.js)
 * @property {Object.<string, number>} [freight]  a freighter's player-managed cargo hold, commodity → qty (engine/galaxy.js)
 * @property {boolean} [aiLogistics]  a freighter toggled into autonomous haul/service work, like a worker (engine/commands.js issueSetAILogistics, engine/sim.js) — requires FREIGHTER_AI_TECH researched, burns AI Cores while active (engine/haul.js payAIUpkeep)
 * @property {boolean} [collectPoint]  a freighter toggled into collection-point mode (engine/commands.js issueSetCollectPoint) — full hold triggers a SHUTTLE run to the nearest Command Center and back to `anchor` (engine/haul.js assignShuttle/updateFreighterShuttle); no research needed
 * @property {{x:number, y:number}} [anchor]  a collection-point freighter's home spot, stamped when the mode is switched on — a shuttle run returns here (engine/haul.js updateFreighterShuttle)
 * @property {number} [ferriers]  transient per-tick count of workers ferrying this freighter, manual or auto-assigned (engine/haul.js countLogistics/assignFerry) — stripped on serialize
 * @property {number} [repairers]  transient per-tick count of workers assigned to repair THIS unit (it's a valid repair-job target too), engine/repair.js countRepairJobs — stripped on serialize
 * @property {string|null} [homeCC]  a player-assigned home Command Center id (engine/commands.js issueSetHomeBase) — overrides zoneFirst's usual nearest-CC guess for this unit's haul/service/ferry/repair job search (engine/gather.js zoneFirst); persisted; a stale reference to a destroyed CC is harmless, ignored and falls back to nearest-CC
 * @property {{progress:number, time:number}} [recycling]  an in-progress player Recycle (engine/commands.js issueRecycle) — persisted; progress 0..1, removes the unit and refunds part of its cost at 1 (engine/recycle.js updateUnitRecycle)
 * @property {boolean} [armed]  a Helium Bomb set to detonate on attack/enemy presence/command (engine/bomb.js)
 * @property {number} [fuseUntil]  the state.time an ARMED Helium Bomb's lit fuse detonates at — set by lightFuse, absent while unlit (engine/bomb.js)
 * @property {Unit} [squadLeader]     transient, NEVER persisted: the leader this unit is following, if any (engine/commands.js setSquadLeader) — a live object reference
 * @property {Unit[]} [squadFollowers]  transient, NEVER persisted: the units following THIS unit as their leader (engine/commands.js dispatchFormation)
 * @property {number} [facing]  a player-set facing angle (radians), from a click-and-drag move/attack-move (engine/commands.js applyFacing) — overrides the movement-inferred angle a STATIONARY unit would otherwise freeze at (renderShared.js updateFacing); a plain (non-drag) move/attack-move clears it, so it never lingers stale after a later un-aimed order
 * @property {number} [kills]  confirmed kills this unit has landed (engine/combat.js performAttack's target-died branch, unit-kind attackers only) — feeds entities.js rankMults for the veterancy damage-dealt/damage-taken multipliers and renderUnits.js's chevron overlay; absent reads as 0 (fresh off the line)
 */

/**
 * A structure (engine/state.js makeBuilding). Optional tail: fields only some building
 * types carry (a Spaceport's tier, a Datacenter's research queue).
 * @typedef {Object} Building
 * @property {"building"} kind
 * @property {string} id
 * @property {string} type
 * @property {string} owner
 * @property {number} x
 * @property {number} y
 * @property {number} radius
 * @property {number} hp
 * @property {number} maxHp
 * @property {boolean} constructing
 * @property {number} buildProgress
 * @property {Array<{unitType:string, progress:number, alt?:boolean}>} queue   `alt` records that the job was charged the unit's altCost, so cancelProduction refunds the commodity actually paid
 * @property {number} attackTimer
 * @property {string|null} targetId
 * @property {{x:number, y:number, nodeId?:string|null}} rally   rally-to-resource: a rally dropped on a live node carries its id, and a unit produced there spawns already mining (engine/production.js)
 * @property {number} [tier]          Spaceport upgrade tier (engine/galaxy.js)
 * @property {number} [lastLanding]   Spaceport: galaxy.time it last received a jump (engine/galaxy.js landingZone)
 * @property {Array<{techId:string, progress:number}>} [researchQueue]  Datacenter (TECHS) or Refinery (UPGRADES) — engine/techtree.js updateResearch resolves the right table by building.type
 * @property {boolean} [paused]       player-paused factory / rig / Combustion Generator / Reactor (frees its Power, or — for a source — takes it off the grid, engine/industry.js sourceActive)
 * @property {boolean} [electrified]  Odyssey: a non-power building wired into the grid for +30% (engine/industry.js)
 * @property {number} [charge]        wonder charge 0..1 (engine/wonder.js)
 * @property {boolean} [capital]      an Odyssey homeworld Command Center promoted by engine/galaxy.js's
 *                                   upgradeToCapital — permanent, and the reason engine/colony.js
 *                                   refuses to pack it back into a colony ship
 * @property {boolean} [rivalAscended] per-BUILDING idempotency latch stamped by engine/victory.js
 *   checkEndlessWin so a finished rival Gate emits its `rivalGateComplete` event once. Distinct
 *   from galaxy.rivalAscended, which is the campaign-level Set of ascended WORLD ids
 * @property {number} [digProgress]   Plasma Rig dig-cycle progress (engine/rig.js)
 * @property {number} [digCount]      Plasma Rig completed digs (drives the deterministic yield roll)
 * @property {string} [lastTier]      Plasma Rig last strike tier (HUD)
 * @property {number} [lastYield]     Plasma Rig last strike amount (HUD)
 * @property {Object.<string, number>} [store]  a producer's finite output buffer, commodity → qty (engine/haul.js)
 * @property {Object.<string, number>} [input]  a factory's (or a fuel-burning power station's, or an ammo-fed static defense's) finite input larder, commodity → qty (engine/haul.js)
 * @property {number} [haulers]       transient per-tick count of workers hauling from this producer (engine/haul.js)
 * @property {number} [servers]       transient per-tick count of workers servicing this factory (engine/haul.js)
 * @property {"high"|"normal"|"low"} [logiPriority]  per-building auto-haulage priority (engine/commands.js issueSetLogiPriority, engine/haul.js LOGI_PRIORITIES/priorityWeight) — missing reads as "normal"
 * @property {boolean} [powered]      transient: a Combustion Generator is fed & granting Power this tick (engine/industry.js)
 * @property {string} [fuel]          transient: which fuel the Generator burned this tick (HUD)
 * @property {number} [menderClaims]  transient: auto-repair Menders committed to this building this tick (engine/sim.js)
 * @property {number} [repairers]     transient: workers already assigned to REPAIR this building this tick (engine/repair.js countRepairJobs) — stripped on serialize
 * @property {{progress:number, time:number}} [recycling]  an in-progress player Recycle (engine/commands.js issueRecycle) — persisted; progress 0..1, removes the building and refunds part of its cost at 1 (engine/recycle.js updateBuildingRecycle); the building stays fully functional until then
 */

/**
 * A resource deposit on the map (engine/map.js).
 * @typedef {Object} ResourceNode
 * @property {string} id
 * @property {string} com
 * @property {number} amount
 * @property {number} max
 * @property {number} x
 * @property {number} y
 * @property {boolean} [hidden]   a cache, invisible until scouted
 * @property {number} [miners]    workers currently assigned (engine/gather.js saturation)
 * @property {boolean} [depletedAnnounced]  this node's own one-shot "it ran dry" latch — set when
 *   engine/gather.js pushes its nodeDepleted event, so several miners landing the finishing tick
 *   together announce it once between them rather than once each. Transient, never persisted (a
 *   reloaded dry node simply never announces again, which is the same outcome).
 * @property {boolean} [crater]   spawned by a Helium Bomb detonation (engine/bomb.js), not
 *   engine/map.js generation — needs its whole shape saved/restored, not just its amount
 *   (engine/persist.js)
 * @property {boolean} [wreck]    spawned by battle wreckage maturing (engine/wreckage.js), not
 *   engine/map.js generation — needs its whole shape saved/restored, same as a crater node
 *   (engine/persist.js)
 */

// ---- players / AI ---------------------------------------------------------------

/**
 * One side's economy + identity (engine/state.js).
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} faction
 * @property {boolean} isAI
 * @property {Resources} resources
 * @property {string} color
 * @property {Object.<string, boolean>} upgrades
 */

/**
 * The AI opponent's runtime bookkeeping — state.ai (engine/state.js). Distinct from
 * state.players.ai (that's the AI's economy). Serialized under the save's `ai:` key.
 * @typedef {Object} AiState
 * @property {number} think
 * @property {string|null} scoutId
 * @property {{x:number, y:number}|null} colonyTarget
 * @property {number|null} apm
 * @property {boolean} micro
 * @property {string} strategy     player-picked AI strategy (engine/aiStrategy.js), read via strategyFor(state, owner) — "default" ⇒ byte-identical to the pre-strategy behavior
 * @property {number|null} lastThreatAt   sim-time of the last threat seen near home; drives the Economic strategy's war-footing window (engine/ai.js)
 * @property {string} difficulty   splash-screen Easy/Medium/Hard pick (engine/aiDifficulty.js), read via difficultyFor(state)
 * @property {number} actionBudget
 * @property {number} attackForce
 * @property {boolean} attackDesperate
 * @property {number|null} nextAttackAt
 * @property {number} unitsBuilt
 * @property {number} waveCount
 * @property {number|null} nextWaveAt
 * @property {number} intelMil    PEAK ore-value of enemy MILITARY assets seen (aiIntel.js); the
 *   live belief is this faded by intelMilAt's age, computed at read and never written back
 * @property {number|null} intelMilAt sim-time that military peak was set; null = never
 * @property {number} intelEco    PEAK ore-value of enemy ECONOMIC assets seen
 * @property {number|null} intelEcoAt sim-time that economic peak was set; null = never
 * @property {number|null} intelAt sim-time it last saw anything of the enemy; null = never
 * @property {number|null} adaptMode damped stance from that belief: 0 economy, 1 massing, 0.5 neutral
 * @property {Archetype} archetype
 */

// ---- map / world state ----------------------------------------------------------

/**
 * A fog grid (engine/fog.js) — one byte per cell, per side.
 * @typedef {Object} Fog
 * @property {number} cols
 * @property {number} rows
 * @property {Uint8Array} explored
 * @property {Uint8Array} visible
 */

/**
 * The generated map (engine/map.js) — regenerated deterministically from the seed.
 * @typedef {Object} GameMap
 * @property {Object} planet   the world's archetype record from data.js (NOT the id string — that's state.planetId)
 * @property {number} width
 * @property {number} height
 * @property {{player:{x:number,y:number}, ai:{x:number,y:number}}} bases
 * @property {ResourceNode[]} nodes
 * @property {Map<string, ResourceNode>} nodesById
 * @property {*} [terrain]
 * @property {Object} [modifiers]
 */

/**
 * An Odyssey world's price book (engine/market.js).
 * @typedef {Object} Market
 * @property {Resources} base
 * @property {Resources} pressure
 * @property {Resources} [glut]
 */

/**
 * An Odyssey world's neighbour stance (engine/diplomacy.js).
 * @typedef {Object} Diplomacy
 * @property {number} stance
 * @property {number} [depletion]
 * @property {number} [tributes]
 * @property {number|null} [provokedAt]   sim-time the neighbour was last provoked (engine/diplomacy.js)
 * @property {number} [goodwill]          accumulated gifts/favors credit (engine/diplomacy.js)
 * @property {*} [request]                the neighbour's pending favor request, or null (engine/diplomacy.js)
 * @property {number} [lastFavorBucket]   which favor bucket was last offered; -1 ⇒ none yet
 * @property {number} [lastAiUnits]  attached post-construction by engine/diplomacy.js, not by createDiplomacy
 * @property {boolean} [pacified] Domination with teeth: stamped by engine/galaxy.js checkDomination
 *   when this world is razed — floors the drift target at APPEASE_FLOOR (Neutral) permanently
 * @property {number} [factionEchoUntil] Faction memory (grievance direction): state.time deadline
 *   until which forgiveness composes at FACTION_ECHO_FORGIVE_MULT, set by a faction-mate's pacification
 * @property {number} [factionWarmth] Faction memory (allied direction): raw count of this world's
 *   OTHER faction-mates currently Allied, refreshed by engine/galaxy.js updateFactionWarmth
 */

/**
 * The mutable simulation world (engine/state.js createGameState). The required block is
 * the constructed shape; the optional tail is attached later — the per-tick broad-phase
 * grid, the Odyssey per-world layers, and transient scenario/flag fields.
 * @typedef {Object} State
 * @property {number} time
 * @property {number} tick
 * @property {number} nextEntityId   this state's OWN entity-id counter (engine/state.js newId) —
 *   independent of any other live state's, so two interleaved matches never mint colliding ids
 *   (ADR-0011/TASKS.md T-016). Threaded through every real minting path (seedPlayer, issueBuild,
 *   production, colony deploy/pack); a caller that omits it falls back to a legacy process-wide
 *   watermark, unique to that state's own Maps
 * @property {boolean} over
 * @property {string|null} winner
 * @property {string|null} [winReason]  why the match ended — "elimination" | "mutual-wipe-score" | "timeout-score" (engine/victory.js finish); unset for an Odyssey-sandbox finish (checkEndlessLoss/checkEndlessWin), which has no clock/score tiebreak to explain
 * @property {string[]} [eliminated]   T-046: every owner no longer standing (lost its last Command
 *   Center, or surrendered), monotonic — engine/victory.js checkWinCondition/surrender. Optional
 *   here (lazily initialized by both) so a hand-built minimal test state never needs to set it.
 * @property {string[]} [surrendered]  T-046: the subset of `eliminated` who quit voluntarily —
 *   kept separate so a genuine same-tick mutual wipe can still resolve by score (the 2-seat
 *   game's own existing behavior) while a surrendered seat can never win that tiebreak
 * @property {number|null} seed
 * @property {string} planetId
 * @property {number} sizeMult
 * @property {number} resourceMult
 * @property {boolean} swapAsym   which side plays which half of an asymmetric world's matchup (engine/map.js) — default false
 * @property {number|null} [matchTimeLimit]  a skirmish's Quick/Standard/Marathon override of DEFAULT_MATCH_TIME_LIMIT (engine/victory.js), from setup.js's Match length row — null/unset ⇒ the 40-minute default
 * @property {number|null} popCap   per-side supply cap from setup.js's population row; null ⇒ the engine default (engine/supply.js)
 * @property {boolean} endless
 * @property {GameMap} map
 * @property {string[]} owners   the world's side ids in iteration order (["player","ai"]) — drives the owner-generic scaffold
 * @property {Object.<string, Player>} players   keyed by owner id; index-signature so state.players[unit.owner] checks
 * @property {Map<string, Unit>} units
 * @property {Map<string, Building>} buildings
 * @property {string[]} selection
 * @property {Object.<string, Fog>} fogs   per-owner fog, keyed by owner id; state.fog/state.fogAI are aliases into it
 * @property {Fog} fog
 * @property {Fog} fogAI
 * @property {Object.<string, AiState|null>} controllers   T-042 — the real, N-capable AI controller
 *   registry, keyed by owner id (engine/controllers.js's controllerFor). "ai" is always present in
 *   a normal 2-owner match; "player" (self-play, tools/selfplay.js) and any owner beyond the
 *   default pair (T-041's own ownerDefs) are populated only when isAI:true for that owner.
 * @property {AiState} [ai]   LIVE accessor alias into controllers.ai (engine/controllers.js's
 *   attachControllerAliases) — not a real constructive field, installed right after the state
 *   object itself is built, hence optional here: every real State has it by the time anything else
 *   runs, but the object literal that becomes one doesn't include it yet at construction.
 * @property {AiState|null} [playerAi]   the SAME kind of live alias, into controllers.player — the
 *   SECOND AI controller, driving owner "player" in self-play (tools/selfplay.js). null in a normal
 *   game; populated after createGameState, never by it
 * @property {Array<Object>} events
 * @property {Array<{id:string, x:number, y:number, owner:string, spawnAt:number}>} craters
 *   pending Helium Bomb craters awaiting maturity into a real ResourceNode (engine/bomb.js)
 * @property {Array<{id:string, x:number, y:number, n:number, value:number, createdAt:number, goods:Object.<string,number>, spawnAt:number}>} wrecks
 *   pending battle-wreckage sites awaiting maturity into real ResourceNodes (engine/wreckage.js);
 *   `value` is the running, un-scaled battle-intensity total that gates a bonus-material roll;
 *   `createdAt` anchors how far a later contribution may extend `spawnAt` (capped at WRECK_MAX_DELAY)
 * @property {Object} [unitGrid]     broad-phase index, rebuilt each tick (engine/grid.js)
 * @property {Market} [market]       Odyssey per-world price book (engine/galaxy.js)
 * @property {Diplomacy} [diplomacy] Odyssey neighbour stance (engine/galaxy.js)
 * @property {boolean} [inGalaxy]    part of an Odyssey galaxy → per-world defeat off
 * @property {boolean} [background]  a held colony the player isn't currently on
 * @property {*} [scenario]          scripted-scenario bookkeeping (engine/scenarios.js)
 * @property {*} [anvils]            per-tick Aegis anvil index (engine/sim.js collectAnvils)
 */

// ---- AI ------------------------------------------------------------------------

/**
 * The per-think-cycle snapshot the AI's decision phases share (engine/ai.js). Built once by
 * aiContext(); the three *Reserve fields are running ore holdbacks one phase passes to the next
 * (an expansion banks ore that the infrastructure phases then leave alone).
 * @typedef {Object} AiContext
 * @property {string} owner   which side this snapshot is for — "ai" (always) or "player" (Tier 1 self-play only)
 * @property {string} enemyOwner   the other side — engine/aiCommon.js otherOwner(owner)
 * @property {Fog} fog   `owner`'s OWN fog of war (state.fogs[owner]) — every intel-gated read in aiMilitary.js/aiEconomy.js/aiWorkers.js uses this, never a hardcoded state.fogAI
 * @property {Object} controller   this owner's AI runtime bookkeeping — state.ai for "ai", state.playerAi for "player" (engine/aiCommon.js controllerFor)
 * @property {Archetype} archetype
 * @property {(field: string) => *} arch   reads the archetype field, letting its Odyssey overlay win
 * @property {Strategy} strategy   this owner's AI strategy (engine/aiStrategy.js strategyFor(state, owner))
 * @property {boolean} warFooting   true while a strategy with warFootingTime has seen a threat recently (engine/ai.js)
 * @property {{ posture: number|null, confidence: number, mil: number, eco: number, age: number|null }} enemy
 *   this controller's BELIEF about its opponent (engine/aiIntel.js readEnemy), snapshotted once per
 *   think cycle. `posture` 0 = pure economy, 1 = pure war, null = never seen anything — which a
 *   consumer must treat as "I don't know", never as "they are peaceful".
 * @property {Player} ai   this owner's economy/faction Player object (state.players[owner]) — named `ai` for historical/API-stability reasons, not literally owner "ai"
 * @property {Unit[]} workers
 * @property {Unit[]} army
 * @property {Unit[]} rangers
 * @property {Unit[]} bombs   this side's Helium Bomb unit(s), if any (engine/aiSuperweapon.js)
 * @property {Building[]} buildings
 * @property {Building|undefined} cc
 * @property {Unit|null} colonyShip
 * @property {Building|undefined} barracks
 * @property {Building|undefined} refinery
 * @property {Building[]} allBarracks
 * @property {Object[]} threats
 * @property {number} oreReserve
 * @property {number} foundryReserve
 * @property {number} refineryReserve
 * @property {number} industryReserve   Odyssey: the grid / bootstrap-chain holdback (engine/aiIndustry.js aiIndustryReserve)
 */

// ---- Odyssey galaxy -------------------------------------------------------------

/**
 * Galaxy construction settings, carried on the galaxy and reused per planet.
 * @typedef {Object} GalaxySettings
 * @property {string} difficulty
 * @property {number} sizeMult
 * @property {number} resourceMult
 * @property {string} playerFaction
 * @property {number} [aiApm]
 * @property {boolean} [aiMicro]
 * @property {string} [aiStrategy]
 * @property {string} [startId]        which world was actually landed on — the player's pick, or the seed's own draw
 * @property {number|null} [popCap]    per-side supply cap carried onto every world this galaxy generates
 */

/**
 * A standing shipping route between two held worlds (engine/galaxy.js createLane/runLanes).
 * @typedef {Object} Lane
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string[]} commodities
 * @property {string[]} shipIds   the freighters assigned to fly it; deduplicated by assignShipToLane
 */

/**
 * The Odyssey open-world meta-state (engine/galaxy.js createGalaxy). `planets` maps a
 * world id to its full engine State; the active world's State is game.state.
 * @typedef {Object} Galaxy
 * @property {number} seed
 * @property {number} credits
 * @property {string} activeId
 * @property {string[]} worlds
 * @property {Map<string, State>} planets
 * @property {GalaxySettings} settings
 * @property {number} tick
 * @property {number} time
 * @property {number} entitySeq
 * @property {Map<string, Object>} colonyNotes
 * @property {Set<string>} pacified
 * @property {string[]} pacifyNotes
 * @property {Set<string>} reached
 * @property {string[]} milestones
 * @property {string|null} wonBy
 * @property {number} [lastReliefTime]
 * @property {Set<string>} discovered
 * @property {Map<string, string>} claims
 * @property {Object[]} expansionNotes transient UI queue — freshly-claimed/expanded worlds awaiting a toast; re-derived on load, never persisted
 * @property {Lane[]} lanes          Freight Lanes: standing shipping routes between held worlds (runLanes)
 * @property {number} laneSeq        fresh lane-id counter; must be lifted past every lane id a save carries
 * @property {Map<string, Object>} [colonyPolicies] per-world colony standing orders (engine/colonyPolicy.js)
 * @property {Object|null} [rivalGate]     the neighbour Gate currently being tracked, or null (checkRivalGate)
 * @property {Set<string>} [rivalAscended] worlds whose Gate has completed — the idempotency latch that
 *   keeps the permanent stance ceiling applied. Created lazily by checkRivalGate
 * @property {Object[]} [rivalGateNotes]   transient UI queue of rival-Gate events; created lazily
 */
