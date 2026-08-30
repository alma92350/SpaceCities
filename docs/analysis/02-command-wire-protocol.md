# 02 — Command & Wire Protocol

**Status:** analysis complete, decisive. Primary input to `docs/adr/` (proposed
ADR-0002 *"Wire commands are id-based; `engine/commands.js` is wrapped, not
rewritten"*).

**Sources read:** `/home/user/alma92350/spaceexploration-rts` (read-only clone).
All `file.js:line` citations below refer to that tree unless prefixed with
`SpaceCities/`.

---

## 0. Decisions up front

| # | Decision | Where it lands |
|---|---|---|
| **D1** | **Wrap, do not rewrite.** `engine/commands.js` keeps its object-ref signatures. A new `net/commandCodec.js` owns id→object resolution, ownership, fog and rate limits. | §4 |
| **D2** | Exactly **one** signature change to the engine: `issueSetRally(building, …)` → `issueSetRally(state, buildingId, …)`. 3 call sites. Everything else is untouched. | §4.4 |
| **D3** | The wire envelope is **versioned, id-based, owner-stamped by the server (never by the client), and tick-scheduled**. The client's `ownerId` and `tick` fields are advisory/telemetry only. | §3.1 |
| **D4** | **Selection id arrays are ORDER-SIGNIFICANT and must never be sorted.** `ids[0]` is the formation leader (`engine/commands.js:145`, `:195`) and `issueEscort` derives ring slots from array index (`engine/commands.js:363`). | §3.3 |
| **D5** | Application order is `(applyTick, ownerIndex, clientSeq)` — `ownerIndex = state.owners.indexOf(owner)`, `engine/state.js:227`. Commands apply **immediately before `tick(state, dt)`**, never inside it. | §5 |
| **D6** | `state.selection` is UI-only. It moves to the client session. The field stays on `State` as a permanently-empty array (zero churn — `removeEntity` writes it, `engine/state.js:347`), guarded by a test that no server module *reads* it. | §6 |
| **D7** | A match is replayable from `{engineCommit, createGameStateOpts, dt, aiSeatConfigs, orderedCommandLog}` — **provided B1 below is fixed**. | §7 |
| **D8** | **Five engine defects block multiplayer** and must be fixed before the codec ships. The worst is a module-global entity-id counter that makes two concurrent matches in one Node process non-replayable. | §8 |

**Scope correction (important).** The brief states `engine/commands.js` is the
entire player-intent surface. It is the entire *unit-order* surface. It is **not**
the entire player-intent surface: `hudSelection.js:20-35` imports and calls
~20 further cost-bearing engine mutators directly (production, research, market,
diplomacy, colony, galaxy). See §1.6. The wire protocol must cover both, and the
second group is where the money is.

---

## 1. Signature audit — every export of `engine/commands.js`

22 exports, `engine/commands.js:231`–`:533`.

Legend for **Params**: `OBJ` = live object reference (unserialisable), `ID` =
string id, `SC` = scalar/plain-JSON, `STATE` = the whole `State`.

### 1.1 The table

| # | Function | Line | Exact signature | Param kinds | Owner check? | Afford check? | Mutates `players[x].resources`? | State written |
|---|---|---|---|---|---|---|---|---|
| 1 | `issueMove` | 231 | `(units, x, y, queue = false, formation)` | `units:OBJ[]`, `x,y,queue:SC`, `formation:SC` | **NO** | n/a | no | `u.order`, `u.orderQueue`, `u.hold`, `u.squadLeader`, `leader.squadFollowers`, `u.facing`, `order.speedCap` |
| 2 | `issueGather` | 237 | `(units, nodeId, queue = false)` | `units:OBJ[]`, `nodeId:ID`, `queue:SC` | **NO** | n/a | no | `u.order={type:"gather",nodeId}` (filtered by `canGatherType`) |
| 3 | `issueServiceBuilding` | 244 | `(units, buildingId, queue = false)` | `units:OBJ[]`, `buildingId:ID` | **NO** (neither unit nor building) | n/a | no | `u.order={type:"service",buildingId,phase:"plan",manual:true}` |
| 4 | `issueFerryFreighter` | 255 | `(units, freighterId, queue = false)` | `units:OBJ[]`, `freighterId:ID` | **NO** | n/a | no | `u.order={type:"ferry",…}` |
| 5 | `issueRepair` | 267 | `(units, targetId, queue = false)` | `units:OBJ[]`, `targetId:ID` | **NO** | n/a | no | `u.order={type:"repair",targetId,phase:"toSite",manual:true}` |
| 6 | `issueSetHomeBase` | 281 | `(units, ccId)` | `units:OBJ[]`, `ccId:ID` | **NO** | n/a | no | `u.homeCC` — `ccId` never validated as existing, as a building, as a CC, or as owned |
| 7 | `issueSetAILogistics` | 295 | `(units, on, state)` | `units:OBJ[]`, `on:SC`, `state:STATE` | **partial** — reads `state.players[u.owner].upgrades` (`:298`), so it is *correctly owner-scoped for the tech gate*, but does not check the caller owns the unit | n/a | no (upkeep is charged later, `haul.js payAIUpkeep`) | `u.aiLogistics`, `u.cargo` |
| 8 | `issueSetCollectPoint` | 310 | `(units, on)` | `units:OBJ[]`, `on:SC` | **NO** | n/a | no | `u.collectPoint`, `u.anchor` |
| 9 | `issueSetLogiPriority` | 330 | `(state, buildingId, priority)` | `state:STATE`, `buildingId:ID`, `priority:SC` | **NO** | n/a | no | `b.logiPriority` on **any** building in the world |
| 10 | `issueAttack` | 343 | `(units, targetId, queue = false)` | `units:OBJ[]`, `targetId:ID` | **NO** — and no hostility check either | n/a | no | `u.order={type:"attack",targetId}` (filtered to `def.attack \|\| role==="support"`) |
| 11 | `issueAttackMove` | 350 | `(units, x, y, queue = false, formation)` | as `issueMove` | **NO** | n/a | no | as `issueMove`, order type `attack-move` |
| 12 | `issueEscort` | 361 | `(units, targetId, queue = false)` | `units:OBJ[]`, `targetId:ID` | **NO** | n/a | no | `u.order={type:"escort",targetId,slot:i,slots:n}` — **no role filter at all** |
| 13 | `issueHoldFormation` | 375 | `(units, shape = "grid", leaderPos = "front")` | `units:OBJ[]`, `shape,leaderPos:SC` | **NO** | n/a | no | `hold-formation` orders + `u.hold` for `role==="combat"`; anchor is the **live centroid** of `units` |
| 14 | `issueBuild` | 390 | `(state, workerId, buildingType, x, y)` | `state:STATE`, `workerId:ID`, `buildingType,x,y:SC` | **NO** — derives `player` from `worker.owner` (`:393`) | **YES** `canAfford` `:404` | **YES — `payCost` `:407`** | mints a `constructing` building into `state.buildings`, sets `worker.order`; **returns the new building id** |
| 15 | `issueAssistBuild` | 420 | `(units, buildingId, buildingType, queue = false)` | `units:OBJ[]`, `buildingId,buildingType:ID/SC` | **NO** | n/a | no | `u.order={type:"build",buildingId}`; **`buildingType` is trusted from the caller** and only used to resolve the eligibility category (`:421`) |
| 16 | `issueStop` | 434 | `(units)` | `units:OBJ[]` | **NO** | n/a | no | clears `order`, `orderQueue`, `hold`, `recycling`, `squadLeader` |
| 17 | `issueRecycle` | 444 | `(entities)` | `entities:OBJ[]` (mixed `Unit`\|`Building`) | **NO** | n/a | **indirectly YES** — `beginRecycle` starts a timer that `recycle.js:136-138` later banks into `state.players[entity.owner].resources`, and `removeEntity`s the entity | `e.recycling`, `e.order`, `e.hold` |
| 18 | `issueCancelRecycle` | 454 | `(entities)` | `entities:OBJ[]` | **NO** | n/a | no | clears `e.recycling` |
| 19 | `issueHold` | 462 | `(units)` | `units:OBJ[]` | **NO** | n/a | no | `u.hold = true`, clears orders (combat role only) |
| 20 | `issuePatrol` | 480 | `(units, points)` | `units:OBJ[]`, `points:SC[]` | **NO** | n/a | no | a looping `attack-move … patrol:true` chain; **`points` length is unbounded** |
| 21 | `issueScout` | 509 | `(units)` | `units:OBJ[]` | **NO** | n/a | no | `u.order={type:"scout",speedCap?}` (scout role only) |
| 22 | `issueSetRally` | 531 | `(building, x, y, nodeId = null)` | `building:OBJ`, `x,y,nodeId:SC` | **NO** | n/a | no | `building.rally = {x,y,nodeId}` — **zero validation of anything** |

### 1.2 The central problem, confirmed

**20 of 22 take live object references.** Only `issueBuild` (`:390`) and
`issueSetLogiPriority` (`:330`) are fully id-based; `issueSetRally` (`:531`) is
the extreme case, taking a bare `Building` object with no `state` at all.

The object refs are not incidental — they are structural. `dispatchFormation`
(`:144`) *stores* references: `leader.squadFollowers = newFollowers`
(`:195`) and `dispatch(units[i], {type:"follow-leader", leader, …})` (`:204-207`)
puts a **live `Unit` object inside an order**. `setSquadLeader` (`:46`) maintains
a bidirectional object graph. That graph is explicitly non-serialisable and
`persist.js` already deals with it by *dropping* it — see the comment at
`engine/commands.js:43-45`: *"Transient, session-only state (never persisted — see
persist.js's serPlanet, which strips both fields and drops a live follow-leader
order entirely rather than trying to serialize the object reference it carries)."*

**Consequence for netcode:** the object graph is fine *inside* the authoritative
server sim (it never crosses a wire). What crosses the wire is only the *intent*.
So the id→object boundary belongs in an adapter, not in the engine. This is the
single most important architectural fact in this document, and it is what makes
D1 correct.

### 1.3 Hidden inputs that are not parameters

Three commands read state the wire schema must therefore also carry or recompute:

- `issueHoldFormation` (`:377-379`) computes the anchor from the **live centroid**
  of the passed units. The anchor is therefore a function of *when* the command
  applies. Two identical commands applied at different ticks produce different
  worlds. Scheduling must be authoritative and logged (§5).
- `issueMove`/`issueAttackMove` cap group speed from `UNITS[u.type].speed` of the
  live set (`groupSpeedCap`, `:66-69`) and re-derive `leader.squadFollowers`.
- `issueScout` (`:514-518`) reads and **prunes** `u.squadFollowers` by `hp > 0`.

### 1.4 The `owner === "player"` gate — a hard multiplayer blocker

`engine/commands.js:155`:

```js
if (leader.owner !== "player") {
  const spots = formationSlots(units, x, y, formation);
  units.forEach((u, i) => dispatch(u, makeLeaderOrder(spots[i]), queue));
  return;
}
```

The entire leader/follower squad mechanic — the thing that makes formations
*formations* rather than a one-shot grid spread — is gated on the literal owner
id `"player"`. In a 4-player match with owners `p1..p4`, **no seat gets
formations**. See §8/B2.

### 1.5 Silent-skip is the house style

Every role/capability filter in this file *silently skips* ineligible units
rather than failing the call (`canGatherType` `:238`, `canLogisticsType` `:246`,
`role === "combat"` `:464`, `canBuildCategory` `:422`). This is deliberate and
documented (`:293-294`, `:441-443`). **The codec must preserve it**: a mixed
selection must not be rejected wholesale because one unit is ineligible. Only
*ownership* violations are hard rejects (§2.6).

### 1.6 The second intent surface — `engine/commands.js` is not the whole story

`hudSelection.js:20-35` imports these directly, and they are all reachable from a
button click:

| Module | Exports the HUD calls | Cost-bearing? |
|---|---|---|
| `engine/production.js` | `queueProduction` `:118`, `cancelProduction` `:164`, `researchUpgrade` `:185` | **yes** — `payCost` at `:152`, `:205`; refund at `:173` |
| `engine/techtree.js` | `researchTech` `:190`, `cancelResearch` `:224` | **yes** |
| `engine/market.js` | `sell` `:164`, `buy` `:208` | **yes** |
| `engine/diplomacy.js` | `offerTribute` `:248`, `offerGift` `:271`, `fulfillRequest` `:290` | **yes** |
| `engine/colony.js` | `deployColonyShip` `:31`, `packCommandCenter` `:70` | **yes** (`PACK_COST`, `:86`) |
| `engine/colonyPolicy.js` | `setColonyPolicy` `:82` | no |
| `engine/bomb.js` | `lightFuse` `:249` | no (destructive) |
| `engine/galaxy.js` | `upgradeSpaceport`, `loadFreighter`, `unloadFreighter`, `createLane`, `deleteLane`, `assignShipToLane`, `upgradeToCapital`, `jumpVessel` | **yes** |

All three of `queueProduction`, `cancelProduction`, `researchUpgrade` derive the
paying player from `building.owner`, **not from a caller-supplied owner**:

```js
// engine/production.js:140
const player = state.players[building.owner];
if (!canAfford(player.resources, cost)) return false;
```

So they have exactly the same exposure class as `issueBuild` (§2.2). The wire
protocol below is designed as an open union so these fold in as additional
command types with the same envelope, resolver and ownership rule — see §3.6.
**Recommendation:** ship the unit-order commands (§3.4) in phase 1 and the
economy commands (§3.6) in phase 2, both through the same codec.

---

## 2. Ownership & validation gaps — the anti-cheat surface

**Baseline:** in single-player none of this matters, because the *only* callers
are `inputCommands.js` (which pre-filters to `owner === "player"`, e.g.
`inputCommands.js:99`, `:206`, `:211`) and the AI (which passes its own units).
Ownership enforcement lives entirely in the UI. Expose these over a socket
naively and every one of them becomes a cheat.

Ranked by severity.

### 2.1 CATASTROPHIC — destroy or disable another player's army

| Command | Attack |
|---|---|
| `issueRecycle(entities)` `:444` | Send the enemy's building/unit ids. `canRecycle` (`recycle.js:80`) only refuses a Command Center, a constructing building, or an already-recycling entity. Everything else starts a timer that ends in `removeEntity` (`recycle.js:149`, `:163`). **You can dismantle an opponent's entire base.** |
| `issueStop(units)` `:434` | Send every enemy unit id every tick. Clears `order`, `orderQueue`, `hold`, and `recycling`. The opposing army is permanently frozen — it can still auto-defend (`combat.js` re-acquires), but never moves, gathers, or builds again. |
| `issueAttack(units, targetId)` `:343` | Two attacks in one. (a) Send *your* units at a *friendly/allied* target: `combat.js:46` reads `unit.order.targetId` with **no owner filter**, and `performAttack` (`combat.js:85`) is reached without one — explicit orders are friendly-fire capable, unlike auto-acquisition which does filter (`combat.js:153`, `:243`, `:386`, `:411`). (b) Send *the enemy's* unit ids at *the enemy's own* buildings and they self-destruct. |
| `issueHold(units)` `:462` | Freeze the enemy's combat units in place (`u.hold = true`), then walk past them: `combat.js:83` refuses to chase while `unit.hold`. |

`recycle.js:87-89` carries a comment asserting the guard exists:

> *"Start recycling `entity` in place. Pure state mutation — engine/commands.js's
> issueRecycle checks ownership/canRecycle and handles the unit-order-dispatch
> side…"*

`issueRecycle` (`commands.js:444-450`) checks `canRecycle` and nothing else.
**The comment is wrong.** Fix the comment as part of the codec work so the next
reader is not misled into trusting a check that does not exist.

### 2.2 SEVERE — spend another player's resources

| Command | Attack |
|---|---|
| `issueBuild(state, workerId, …)` `:390` | `const player = state.players[worker.owner]` `:393`, then `payCost(player.resources, def.cost)` `:407`. Name an **enemy** worker id and you drain *their* treasury and hijack *their* worker's order (`:411`). You do not gain the building — but you can bankrupt them and pin their workers to construction sites at will. Placement, prereqs and affordability are all validated **against the victim**, so a well-chosen spam of expensive buildings is a total economic denial. |
| `queueProduction(state, buildingId, …)` `production.js:118` | Same shape: `state.players[building.owner]` `:140`, `payCost` `:152`. Fill the enemy's queues, drain their bank, and consume their supply cap (`:147`). |
| `cancelProduction(state, buildingId, i)` `production.js:164` | Delete an arbitrary index out of any building's queue (`:169`). Refunds to the owner, so it is pure griefing: cancel the enemy's army as fast as they queue it. |
| `researchUpgrade` / `researchTech` | Same derivation; burn the victim's bank on a doctrine they did not choose, and — because of the doctrine lock (`production.js:194-195`) — **permanently deny them the other doctrine.** This is the most damaging economic attack in the set. |

### 2.3 MODERATE — sabotage, waste, and free labour

| Command | Attack |
|---|---|
| `issueSetLogiPriority(state, buildingId, priority)` `:330` | No owner check anywhere. Set every enemy factory to `"low"` and their logistics chain starves (`haul.js priorityWeight`). |
| `issueSetRally(building, x, y, nodeId)` `:531` | Object-ref, zero validation. Once the codec resolves an id, an unguarded path re-points every enemy production building's rally into a corner of the map — or onto your own guns. |
| `issueSetHomeBase(units, ccId)` `:281` | `ccId` is never validated (not existence, not kind, not owner). Point the enemy's workers at *your* CC and their whole `zoneFirst` job search (`gather.js`) goes wrong. |
| `issueRepair(units, targetId)` `:267` | No owner check on either side. Order *your* workers to repair the *enemy's* CC. `repair.js:161`/`:172` gate the passive Mender scan on `owner`, but `updateRepairJob` runs off the explicit order. Mostly self-harm — but in a team game it is a way to launder resources/labour to a nominal opponent. |
| `issueAssistBuild(units, buildingId, buildingType)` `:420` | Two holes. (a) `buildingId` is unvalidated — send workers to accelerate an enemy site. (b) **`buildingType` is trusted from the caller** and is the only thing that resolves the eligibility category (`:421`). A client that lies about the type walks a combat unit onto a construction site the engine would otherwise refuse. The codec must read the type from the *resolved building*, never from the wire. |
| `issueSetAILogistics` `:295` / `issueSetCollectPoint` `:310` | Flip the enemy's freighters into/out of AI-logistics mode. The tech gate is correctly scoped to `u.owner` (`:298`) so you cannot grant them a mode they have not researched — but you can force one on, which burns their AI Cores (`haul.js payAIUpkeep`), or force one off mid-haul. |
| `issueServiceBuilding` `:244` / `issueFerryFreighter` `:255` | Same class: unvalidated target ids, cross-owner assignment. |

### 2.4 MAPHACK — fog is enforced only in the UI

`inputCommands.js` gates target picking on fog: `entityAt` skips non-player
entities that fail `isVisibleAt(state.fog, …)` (`inputCommands.js:58`, `:62`) and
`nodeAt` requires `isNodeDiscovered` (`:69`). **No engine function checks fog.**
A client that ignores its own renderer can:

- `issueAttack` a unit it has never seen (targeted alpha-strikes into fog),
- `issueGather` an undiscovered node — instant map knowledge of every deposit,
- `issueBuild` anywhere on the map: `canPlaceBuilding` (`colliders.js:26-47`)
  checks bounds, building overlap, node overlap and terrain — **never fog and
  never proximity to your own territory**. Wall in an enemy's expansion on turn
  one.

Fog enforcement is therefore a **new server-side rule** the codec must add; it
does not exist anywhere in the engine today.

### 2.5 DoS / resource-exhaustion

- `issuePatrol(units, points)` `:480-493` — `points` is unbounded and every point
  is pushed onto **every** unit's `orderQueue`. `|units| × |points|` allocations
  with no cap. 400 units × 100k points is a server OOM.
- Selection size is unbounded everywhere. `dispatchFormation` → `formationSlots`
  → `clusterUnits` (`formation.js:108`) is superlinear in group size.
- Command rate is unbounded. `issueStop` on 400 units at 20 Hz is cheap for the
  attacker and expensive for the server.

### 2.6 The rule that fixes 2.1–2.3 in one place

> **Every entity id on the wire resolves through the codec, and every resolution
> is scoped to the submitting owner.** A unit/building the submitter does not own
> is a *hard reject* of the whole command. A unit/building that has *ceased to
> exist* is a *silent drop* of that one id (it is a legitimate race between issue
> and apply, not a lie).

That distinction matters: rejecting on "not found" would make the protocol fail
constantly under normal packet latency, while dropping on "not yours" would let
an attacker probe the world for free.

Targets (the *object* of a command, not the *subject*) get a different rule —
see §3.5.

---

## 3. Wire schema

### 3.1 The envelope

One JSON object per command. Sent client→server over the WebSocket; the same
shape, once stamped, is what goes in the replay log.

```jsonc
{
  "v": 1,                     // PROTOCOL_VERSION — reject on mismatch, never coerce
  "seq": 417,                 // per-client monotonic counter, starts at 1
  "tick": 1183,               // ADVISORY: the tick the client believed it was on
  "cmd": { "t": "move", "ids": ["u12","u7"], "x": 900, "y": 412, "q": false,
           "f": { "s": "wedge", "l": "front", "hx": 1, "hy": 0 } }
}
```

Server-side, after admission, it becomes a **log record**:

```jsonc
{
  "v": 1,
  "seq": 417,
  "owner": "p2",              // AUTHORITATIVE — from the socket's session, never the client
  "applyTick": 1186,          // AUTHORITATIVE — stamped by the server at admission
  "cmd": { … },               // verbatim, post-validation
  "result": { "ok": true, "buildingId": "b41" }   // echo for build-like commands
}
```

**Deliberate design points.**

- **`owner` is never on the client→server wire.** It is stamped from the
  authenticated session. A field a client can set is a field a client will lie
  about. This is the single change that neutralises §2.1 and §2.2 by
  construction — an id-based protocol whose owner is client-supplied is *no
  safer* than passing object refs.
- **`tick` is advisory.** The server stamps `applyTick` itself (§5.2). The client
  value is kept only for latency telemetry and for detecting a client running
  ahead.
- **`seq` is the tie-break** and the replay/duplicate guard. `(owner, seq)` must
  be unique; a repeat is dropped idempotently.
- **Short keys** (`t`, `q`, `f`, `s`, `l`, `hx`) because these are the highest-rate
  messages in the protocol. Everything else in the game (chat, lobby, state
  snapshots) can afford long keys.

### 3.2 Batches

One right-click already fans out into several `issue*` calls —
`inputCommands.js:90-96` splits a selection into combatants (`issueAttackMove`)
and everyone else (`issueMove`), and `commandAt` (`:194-285`) picks one of eight
verbs. **Decision: the client resolves the gesture into primitive commands, and
ships them as an atomic batch.**

```jsonc
{ "v": 1, "seq": 418, "cmd": { "t": "batch", "c": [ {…}, {…} ] } }
```

A batch applies at one `applyTick`, in array order, all-or-nothing on validation
(if any member is rejected, the whole batch is rejected — the client's
disambiguation was built on a state it did not actually have). Max 16 members.

Rationale for client-side gesture resolution: `commandAt` is 92 lines of
UI-policy (`inputCommands.js:15-17` calls this out explicitly), it depends on
camera/pick-radius/touch-mode, and an MCP agent has no gesture at all — it wants
to say `attack`, not "right-click at (900,412)". Putting the verb on the wire
also makes the log human-readable, which matters enormously for replay debugging.
The cost is that a lying client can pick a verb the UI would not have offered —
which is exactly what §3.5's server-side re-validation is for.

### 3.3 How selections are expressed

```ts
/** Ordered, de-duplicated entity ids. ORDER IS LOAD-BEARING. */
type Ids = string[];   // 1..400
```

`ids[0]` is the **formation leader**: `dispatchFormation` takes
`const leader = units[0]` (`commands.js:145`), assigns
`leader.squadFollowers = units.slice(1)` (`:195`), and `rankSlotsByRange`
passes `spots[0]` through untouched because *"the leader is a documented player
choice … never re-picked by a stat"* (`:87-88`). `issueEscort` likewise derives
`slot: i, slots: n` from array position (`:363`).

**Therefore the codec must not sort, canonicalise or re-order `ids`.** It
de-duplicates preserving first occurrence, and drops dead ids in place. This is
also why the client's `state.selection` order is preserved through
`applyBoxSelection`'s promote-to-front behaviour (`inputCommands.js:152`) — that
ordering *is* game input and must be logged verbatim.

### 3.4 Command types — phase 1 (unit orders)

```ts
/** engine/formation.js:59-60 — the ONLY legal values. */
type Shape  = "grid" | "line" | "wedge" | "circle";
type LeadPos = "front" | "back" | "center";

/** Rides on move / attack-move. Maps to engine/commands.js's `formation` opts bag. */
interface WireFormation {
  s?: Shape;      // shape;     default "grid"
  l?: LeadPos;    // leaderPos; default "front"
  hx?: number;    // headingX — the right-click-DRAG vector; stamped as unit.facing (commands.js:218)
  hy?: number;    // headingY
}
// NOTE: originX/originY are NOT on the wire. issueHoldFormation derives them
// server-side from the live centroid (commands.js:377-380).

type WireCommand =
  // ---- movement -----------------------------------------------------------
  | { t: "move";        ids: Ids; x: number; y: number; q?: boolean; f?: WireFormation }
  | { t: "attackMove";  ids: Ids; x: number; y: number; q?: boolean; f?: WireFormation }
  | { t: "holdFormation"; ids: Ids; s?: Shape; l?: LeadPos }
  | { t: "patrol";      ids: Ids; pts: Array<{ x: number; y: number }> }   // 1..32
  | { t: "stop";        ids: Ids }
  | { t: "hold";        ids: Ids }
  | { t: "scout";       ids: Ids }

  // ---- targeted at another entity -----------------------------------------
  | { t: "attack";      ids: Ids; target: string; q?: boolean }
  | { t: "escort";      ids: Ids; target: string; q?: boolean }
  | { t: "repair";      ids: Ids; target: string; q?: boolean }
  | { t: "gather";      ids: Ids; node:   string; q?: boolean }
  | { t: "service";     ids: Ids; target: string; q?: boolean }   // building
  | { t: "ferry";       ids: Ids; target: string; q?: boolean }   // own freighter
  | { t: "setHomeBase"; ids: Ids; target: string }                // own command center
  | { t: "assistBuild"; ids: Ids; target: string; q?: boolean }   // NOTE: no buildingType — server reads it

  // ---- construction / teardown --------------------------------------------
  | { t: "build";       worker: string; b: string; x: number; y: number }
  | { t: "recycle";       ids: Ids }   // units AND buildings
  | { t: "cancelRecycle"; ids: Ids }

  // ---- toggles / properties ------------------------------------------------
  | { t: "setAILogistics";  ids: Ids; on: boolean }
  | { t: "setCollectPoint"; ids: Ids; on: boolean }
  | { t: "setLogiPriority"; building: string; p: "high" | "normal" | "low" }
  | { t: "setRally";        building: string; x: number; y: number; node?: string | null }

  // ---- envelope-level ------------------------------------------------------
  | { t: "batch"; c: WireCommand[] };   // 1..16, no nesting
```

**Mapping notes.**

- `q` is `queue` — the Ctrl-modifier. Pure boolean, rides on every command whose
  engine signature has a `queue` parameter. It is *not* meaningful for `stop`,
  `hold`, `scout`, `holdFormation`, `patrol`, `recycle` or the toggles, and is
  rejected as malformed there rather than ignored (silent ignore hides client
  bugs).
- `f` (formation) rides only on `move`/`attackMove`. `holdFormation` takes
  `s`/`l` directly because its engine signature is
  `(units, shape, leaderPos)` (`:375`), not an opts bag.
- **`assistBuild` deliberately drops `buildingType`.** The engine takes it
  (`:420`) but the codec supplies `site.type` from the resolved building — see
  §2.3. This is an example of the codec being *narrower* than the engine on
  purpose.
- `setRally.node` is a `nodeId` or `null` (`:531`); the codec validates it exists
  and is discovered.
- `escort` takes no role filter in the engine (`:361`) — the codec adds none
  either, matching current behaviour exactly, but it *does* reject
  `target ∈ ids` (`inputCommands.js:272` filters the target out client-side; the
  codec does it server-side so the engine cannot be handed a self-escort).

### 3.5 Server-side re-validation rules

For each command the codec applies, in order:

1. **Envelope** — `v === PROTOCOL_VERSION`, `seq` unseen for this owner, shape
   matches the union (unknown key ⇒ reject; JSON only, no prototypes).
2. **Subject resolution** — `ids`/`worker`/`building` resolve to live entities
   **owned by the stamped owner**. Foreign ⇒ hard reject `not-owner`. Missing ⇒
   silent drop of that id; empty result ⇒ reject `empty-selection`.
3. **Bounds** — every `x`/`y` inside `[0, map.width] × [0, map.height]`
   (`colliders.js:31` checks the footprint but the codec checks the raw point
   first, so an absurd coordinate never reaches formation math).
4. **Enum** — `s ∈ FORMATION_SHAPES`, `l ∈ LEADER_POSITIONS`
   (`formation.js:59-60`), `p ∈ LOGI_PRIORITIES` (`haul.js:102`),
   `b ∈ Object.keys(BUILDINGS)`.
5. **Limits** — `ids.length ≤ 400`, `pts.length ≤ 32`, `batch.c.length ≤ 16`,
   plus a per-owner token bucket (recommend 30 commands/sec sustained, burst 60 —
   comfortably above human APM and above the AI's own budgeted rate).
6. **Target visibility** (new rule, §2.4):
   - **own** entity ⇒ no fog check.
   - foreign **unit** ⇒ `isVisibleAt(state.fogs[owner], t.x, t.y)` (`fog.js:49`).
   - foreign **building** ⇒ `isExploredAt(…)` (`fog.js:55`) — remembered
     structures stay attackable, which is standard RTS and matches what the
     renderer already shows.
   - **node** ⇒ `isNodeDiscovered(state.fogs[owner], node)` (`fog.js:66`).
7. **Delegate** to `engine/commands.js`, unchanged. Affordability, prereqs,
   placement, doctrine locks and role filters stay **exactly where they are** —
   `issueBuild:404-407` re-runs `canAfford`/`prereqsMet`/`canPlaceBuilding`
   server-side for free, because the server *is* the authority and the codec
   calls the same function the local game calls.

That last point is the payoff of D1: **`issueBuild`'s placement validation is not
re-implemented in the codec at all.** The codec's only job is to prove the worker
belongs to the submitter; `canPlaceBuilding(state, buildingType, x, y)`
(`colliders.js:26`) then runs against the authoritative state at the scheduled
tick and returns `null` if the ground was taken in the meantime. The codec maps
that `null` to a `refused` result and echoes it to the client, which rolls back
its optimistic ghost. No duplicated collision logic, no drift between client
preview and server truth.

### 3.6 Phase 2 — the economy commands

Same envelope, same resolver, appended to the union:

```ts
type WireCommand2 =
  | { t: "queueProduction";  building: string; u: string; alt?: boolean }
  | { t: "cancelProduction"; building: string; i: number }
  | { t: "researchUpgrade";  building: string; up: string }
  | { t: "researchTech";     building: string; tech: string }
  | { t: "cancelResearch";   building: string; i: number }
  | { t: "deployColonyShip"; ship: string }
  | { t: "packCommandCenter"; building: string }
  | { t: "lightFuse";        unit: string }
  | { t: "marketSell" | "marketBuy"; com: string; qty: number }
  | { t: "setColonyPolicy";  planet: string; patch: object };
```

Every one of these resolves its `building`/`unit`/`ship` id through the same
owner-scoped resolver, which closes §2.2 wholesale. `marketSell`/`marketBuy` and
the diplomacy verbs take no entity id at all and are scoped by the stamped owner
directly — note `market.js:164 sell(galaxy, state, com, qty)` currently has **no
owner parameter**; it will need one (or a per-owner market), which is a genuine
Odyssey-scope design question and is out of scope for this document.

---

## 4. The adapter layer — `net/commandCodec.js`

### 4.1 Recommendation: **wrap, do not change `engine/commands.js`**

**Decision: D1. Keep object-ref signatures. Add `net/commandCodec.js`.**

Reasons, in order of weight:

1. **The object graph is not incidental.** `follow-leader` orders carry a live
   `Unit` (`commands.js:205`), `squadFollowers`/`squadLeader` are a bidirectional
   object graph (`:46-53`), and the file itself documents this as transient,
   deliberately non-serialisable state (`:43-45`). "Make it id-based" is not a
   signature change; it is a rewrite of the squad system plus every consumer in
   `movement.js` (`keepFollowingLeader`, `escortSlot`) — with a real perf cost
   (`test/perf-guard.test.js` exists) from re-doing `state.units.get()` in the
   hot loop.
2. **Blast radius.** **209 call sites** outside `engine/commands.js`, across 20 files:
   `test/commands.test.js` (58), `test/formation.test.js` (36),
   `test/ferry.test.js` (28), `test/recycle.test.js` (16), `inputCommands.js`
   (13), `engine/aiMilitary.js` (11), `input.js` (6), `test/sim.test.js` (6),
   `test/scout.test.js` (6), `test/escort.test.js` (6), `hudSelection.js` (5),
   plus 9 more files. Against 2519 tests and a
   determinism guard, that is a multi-day change with a real chance of a silent
   behavioural drift that only `test/determinism.test.js` would catch — and only
   if the drift happens to change a fingerprinted field.
3. **The AI already holds objects.** `aiMilitary.js`/`aiEconomy.js` iterate live
   units and pass them straight in. Forcing ids means map lookups the AI does not
   need, on the sim's hot path, for zero benefit — the AI never crosses a wire.
4. **A choke point is worth more than scattered guards.** One file to audit, one
   file to fuzz, one file to rate-limit, one file where "did we check ownership?"
   has a single answer. Scattering `owner` parameters into 22 engine functions
   would also mean every AI and test call site must now supply an owner —
   the *same* 209-site churn, plus a permanently wider engine API.
5. **The engine stays DOM-free and pure.** The codec is `net/`, not `engine/`, so
   `test/engine-purity.test.js` and the determinism guard keep their current
   boundary unchanged.

**What we give up:** the engine's public API stays "unsafe by default" — anyone
who calls `issueRecycle` directly can still recycle an enemy. Mitigation: a
guard test asserting that no file under `net/` or `server/` imports
`engine/commands.js` **except** `net/commandCodec.js`. Same idiom as the existing
`test/engine-purity.test.js` import walk (`engine-purity.test.js:35-52`).

### 4.2 The one exception — `issueSetRally` (D2)

`issueSetRally(building, x, y, nodeId)` (`:531`) is the only export taking a bare
entity object with no `state`. It is a 1-line function, has **3 call sites**
total, does no validation whatsoever, and is the only place where the codec would
otherwise have to hand a raw object across the boundary. Change it to match its
id-based sibling `issueSetLogiPriority(state, buildingId, priority)` (`:330`):

```js
export function issueSetRally(state, buildingId, x, y, nodeId = null) {
  const b = state.buildings.get(buildingId);
  if (!b) return;
  b.rally = { x, y, nodeId };
}
```

Cost: 3 call sites (`inputCommands.js:199` + 2 tests). Benefit: the codec's
entity-resolution rule becomes universal with no special case.

`issueSetAILogistics(units, on, state)` (`:295`) has an odd trailing `state`
parameter. **Leave it.** It is ugly, it is not a correctness problem, and
touching it buys nothing.

### 4.3 The codec

```js
/* ============================================================
   net/commandCodec.js — the ONLY bridge between the wire and engine/commands.js.

   Wire commands are id-based, owner-scoped and tick-scheduled. This file
   resolves ids to the live objects engine/commands.js wants, proves the
   submitting owner actually owns them, and delegates. It deliberately
   re-implements NO game rule: affordability, prereqs, placement, doctrine
   locks and role filters all stay in engine/, which the server calls exactly
   as the single-player client does.

   INVARIANT: no other module under net/ or server/ may import
   engine/commands.js. See test/net-boundary.test.js.
   ============================================================ */

"use strict";

import * as cmd from "../engine/commands.js";
import { BUILDINGS } from "../engine/entities.js";
import { FORMATION_SHAPES, LEADER_POSITIONS } from "../engine/formation.js";
import { LOGI_PRIORITIES } from "../engine/haul.js";
import { isVisibleAt, isExploredAt, isNodeDiscovered } from "../engine/fog.js";

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  ids: 400,          // per-command selection cap
  patrolPoints: 32,  // engine/commands.js:484 pushes |ids| x |pts| orders — must be bounded
  batch: 16,
};

export const REJECT = {
  BAD_VERSION:  "bad-version",
  UNKNOWN_TYPE: "unknown-type",
  MALFORMED:    "malformed",
  TOO_MANY:     "too-many",
  NOT_OWNER:    "not-owner",       // a LIE — the submitter does not own this entity
  NO_TARGET:    "no-target",       // the object of the command does not exist
  NOT_VISIBLE:  "not-visible",     // fog gate (a rule the engine does not have)
  EMPTY:        "empty-selection", // every id resolved to nothing (a legitimate race)
  OUT_OF_BOUNDS:"out-of-bounds",
  REFUSED:      "refused",         // the ENGINE said no (afford / prereq / placement)
};

/* ---------- primitives ---------- */

const isId  = v => typeof v === "string" && v.length > 0 && v.length <= 32;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const bool  = v => v === undefined || typeof v === "boolean";

const ok   = (result = null) => ({ ok: true, result });
const err  = code => ({ ok: false, code });

function inBounds(state, x, y) {
  return isNum(x) && isNum(y) && x >= 0 && y >= 0 && x <= state.map.width && y <= state.map.height;
}

/* ---------- resolvers: id -> live object, scoped to `owner` ----------

   Two failure modes, deliberately different:
     - the entity is GONE      -> drop that id (a real race between issue and apply)
     - the entity is SOMEONE ELSE'S -> reject the whole command (a lie)
   Rejecting on "gone" would make the protocol fail under ordinary latency;
   dropping on "not yours" would let an attacker probe the world for free.

   ORDER IS PRESERVED. ids[0] is the formation leader (engine/commands.js:145,
   :195) and issueEscort derives ring slots from array index (:363). Never sort.
*/

function resolveOwn(state, owner, ids, pick) {
  if (!Array.isArray(ids) || ids.length === 0) return err(REJECT.EMPTY);
  if (ids.length > LIMITS.ids) return err(REJECT.TOO_MANY);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!isId(id)) return err(REJECT.MALFORMED);
    if (seen.has(id)) continue;                 // dedupe, first occurrence wins
    seen.add(id);
    const e = pick(state, id);
    if (!e) continue;                           // died in flight — drop
    if (e.owner !== owner) return err(REJECT.NOT_OWNER);
    out.push(e);
  }
  return out.length ? ok(out) : err(REJECT.EMPTY);
}

const pickUnit     = (s, id) => s.units.get(id);
const pickBuilding = (s, id) => s.buildings.get(id);
const pickEntity   = (s, id) => s.units.get(id) || s.buildings.get(id);

const ownUnits      = (s, o, ids) => resolveOwn(s, o, ids, pickUnit);
const ownEntities   = (s, o, ids) => resolveOwn(s, o, ids, pickEntity);   // recycle takes both

function ownBuilding(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const b = state.buildings.get(id);
  if (!b) return err(REJECT.NO_TARGET);
  if (b.owner !== owner) return err(REJECT.NOT_OWNER);
  return ok(b);
}

function ownUnit(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const u = state.units.get(id);
  if (!u) return err(REJECT.NO_TARGET);
  if (u.owner !== owner) return err(REJECT.NOT_OWNER);
  return ok(u);
}

/* Any entity as the OBJECT of a command. Own entities need no fog check; a
   foreign unit must be currently visible, a foreign building merely explored
   (remembered structures stay targetable — standard RTS, and it is what the
   renderer already draws). This rule does not exist in the engine at all:
   inputCommands.js:58,:62 enforces it in the UI only, so a client that ignores
   its own renderer is a maphack today. */
function targetEntity(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const e = pickEntity(state, id);
  if (!e) return err(REJECT.NO_TARGET);
  if (e.owner === owner) return ok(e);
  const fog = state.fogs[owner];
  const seen = e.kind === "building" ? isExploredAt(fog, e.x, e.y) : isVisibleAt(fog, e.x, e.y);
  return seen ? ok(e) : err(REJECT.NOT_VISIBLE);
}

function targetNode(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const n = state.map.nodes.find(n => n.id === id);
  if (!n) return err(REJECT.NO_TARGET);
  return isNodeDiscovered(state.fogs[owner], n) ? ok(n) : err(REJECT.NOT_VISIBLE);
}

/* ---------- formation ---------- */

function decodeFormation(f) {
  if (f === undefined) return undefined;                 // engine default: flat grid spread
  if (f === null || typeof f !== "object") return null;  // null => malformed
  const { s = "grid", l = "front", hx, hy } = f;
  if (!FORMATION_SHAPES.includes(s)) return null;
  if (!LEADER_POSITIONS.includes(l)) return null;
  if (hx !== undefined && !isNum(hx)) return null;
  if (hy !== undefined && !isNum(hy)) return null;
  const out = { shape: s, leaderPos: l };
  if (hx !== undefined) out.headingX = hx;               // the right-click-DRAG facing (commands.js:218)
  if (hy !== undefined) out.headingY = hy;
  return out;
}

/* ---------- the schema table ----------
   One entry per wire type. `run` receives already-resolved, already-owned
   objects and does nothing but call engine/commands.js. Everything that could
   reject has already rejected. */

const SCHEMA = {

  /* ----- movement ----- */
  move: { run(state, owner, c) {
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const f = decodeFormation(c.f); if (f === null) return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueMove(r.result, c.x, c.y, !!c.q, f);
    return ok();
  }},

  attackMove: { run(state, owner, c) {
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const f = decodeFormation(c.f); if (f === null) return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueAttackMove(r.result, c.x, c.y, !!c.q, f);
    return ok();
  }},

  holdFormation: { run(state, owner, c) {
    const s = c.s ?? "grid", l = c.l ?? "front";
    if (!FORMATION_SHAPES.includes(s) || !LEADER_POSITIONS.includes(l)) return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueHoldFormation(r.result, s, l);   // anchor = live centroid, commands.js:377
    return ok();
  }},

  patrol: { run(state, owner, c) {
    if (!Array.isArray(c.pts) || !c.pts.length) return err(REJECT.MALFORMED);
    if (c.pts.length > LIMITS.patrolPoints) return err(REJECT.TOO_MANY);
    for (const p of c.pts) if (!p || !inBounds(state, p.x, p.y)) return err(REJECT.OUT_OF_BOUNDS);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issuePatrol(r.result, c.pts.map(p => ({ x: p.x, y: p.y })));   // strip any extra keys
    return ok();
  }},

  stop:  { run: (s, o, c) => unitsOnly(s, o, c, us => cmd.issueStop(us)) },
  hold:  { run: (s, o, c) => unitsOnly(s, o, c, us => cmd.issueHold(us)) },
  scout: { run: (s, o, c) => unitsOnly(s, o, c, us => cmd.issueScout(us)) },

  /* ----- targeted ----- */
  attack: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = targetEntity(state, owner, c.target); if (!t.ok) return t;
    const r = ownUnits(state, owner, c.ids);        if (!r.ok) return r;
    cmd.issueAttack(r.result, t.result.id, !!c.q);
    return ok();
  }},

  escort: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = targetEntity(state, owner, c.target); if (!t.ok) return t;
    const r = ownUnits(state, owner, c.ids);        if (!r.ok) return r;
    // inputCommands.js:272 filters the target out of its own escort ring; do the
    // same here so the engine can never be handed a unit escorting itself.
    const units = r.result.filter(u => u.id !== t.result.id);
    if (!units.length) return err(REJECT.EMPTY);
    cmd.issueEscort(units, t.result.id, !!c.q);
    return ok();
  }},

  repair:  { run: (s, o, c) => targeted(s, o, c, (us, id, q) => cmd.issueRepair(us, id, q)) },
  service: { run: (s, o, c) => targeted(s, o, c, (us, id, q) => cmd.issueServiceBuilding(us, id, q)) },

  ferry: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = ownUnit(state, owner, c.target); if (!t.ok) return t;   // your OWN freighter only
    const r = ownUnits(state, owner, c.ids);   if (!r.ok) return r;
    cmd.issueFerryFreighter(r.result, t.result.id, !!c.q);
    return ok();
  }},

  setHomeBase: { run(state, owner, c) {
    const t = ownBuilding(state, owner, c.target); if (!t.ok) return t;
    // The engine never validates ccId is even a building (commands.js:281-287).
    if (t.result.type !== "command") return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueSetHomeBase(r.result, t.result.id);
    return ok();
  }},

  assistBuild: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = ownBuilding(state, owner, c.target); if (!t.ok) return t;
    if (!t.result.constructing) return err(REJECT.NO_TARGET);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    // buildingType comes from the RESOLVED SITE, never from the wire — it is the
    // only thing gating unit eligibility (commands.js:421) and a lying client
    // would otherwise walk a combat unit onto a site the engine refuses.
    cmd.issueAssistBuild(r.result, t.result.id, t.result.type, !!c.q);
    return ok();
  }},

  gather: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const n = targetNode(state, owner, c.node); if (!n.ok) return n;
    const r = ownUnits(state, owner, c.ids);    if (!r.ok) return r;
    cmd.issueGather(r.result, n.result.id, !!c.q);
    return ok();
  }},

  /* ----- construction ----- */
  build: { run(state, owner, c) {
    if (typeof c.b !== "string" || !BUILDINGS[c.b]) return err(REJECT.MALFORMED);
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    const w = ownUnit(state, owner, c.worker); if (!w.ok) return w;
    // EVERYTHING else — odysseyOnly, canBuildCategory, canAfford, prereqsMet,
    // canPlaceBuilding, payCost — is re-run by the engine against authoritative
    // state at THIS tick (commands.js:396-412). We re-implement none of it.
    const id = cmd.issueBuild(state, w.result.id, c.b, c.x, c.y);
    return id ? ok({ buildingId: id }) : err(REJECT.REFUSED);
  }},

  recycle:       { run: (s, o, c) => entitiesOnly(s, o, c, es => cmd.issueRecycle(es)) },
  cancelRecycle: { run: (s, o, c) => entitiesOnly(s, o, c, es => cmd.issueCancelRecycle(es)) },

  /* ----- toggles ----- */
  setAILogistics: { run(state, owner, c) {
    if (typeof c.on !== "boolean") return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueSetAILogistics(r.result, c.on, state);   // tech gate is owner-correct at commands.js:298
    return ok();
  }},

  setCollectPoint: { run(state, owner, c) {
    if (typeof c.on !== "boolean") return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueSetCollectPoint(r.result, c.on);
    return ok();
  }},

  setLogiPriority: { run(state, owner, c) {
    if (!LOGI_PRIORITIES.includes(c.p)) return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    cmd.issueSetLogiPriority(state, b.result.id, c.p);   // engine has NO owner check (commands.js:330)
    return ok();
  }},

  setRally: { run(state, owner, c) {
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    let nodeId = null;
    if (c.node !== undefined && c.node !== null) {
      const n = targetNode(state, owner, c.node); if (!n.ok) return n;
      nodeId = n.result.id;
    }
    cmd.issueSetRally(state, b.result.id, c.x, c.y, nodeId);   // see D2: signature changed
    return ok();
  }},
};

/* ---------- shared shapes ---------- */

function unitsOnly(state, owner, c, fn) {
  const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
  fn(r.result); return ok();
}
function entitiesOnly(state, owner, c, fn) {
  const r = ownEntities(state, owner, c.ids); if (!r.ok) return r;
  fn(r.result); return ok();
}
function targeted(state, owner, c, fn) {
  if (!bool(c.q)) return err(REJECT.MALFORMED);
  const t = targetEntity(state, owner, c.target); if (!t.ok) return t;
  const r = ownUnits(state, owner, c.ids);        if (!r.ok) return r;
  fn(r.result, t.result.id, !!c.q); return ok();
}

/* ============================================================
   PUBLIC API
   ============================================================ */

/** Client side: stamp an envelope around a WireCommand. No engine access. */
export function encode(command, seq, clientTick) {
  return { v: PROTOCOL_VERSION, seq, tick: clientTick, cmd: command };
}

/** Server side: envelope shape only. Does NOT touch game state — this runs on
 *  ARRIVAL, so a malformed packet is dropped before it can be scheduled. */
export function decode(envelope) {
  if (!envelope || typeof envelope !== "object") return err(REJECT.MALFORMED);
  if (envelope.v !== PROTOCOL_VERSION) return err(REJECT.BAD_VERSION);
  if (!Number.isInteger(envelope.seq) || envelope.seq < 0) return err(REJECT.MALFORMED);
  const c = envelope.cmd;
  if (!c || typeof c !== "object" || typeof c.t !== "string") return err(REJECT.MALFORMED);
  if (c.t === "batch") {
    if (!Array.isArray(c.c) || !c.c.length || c.c.length > LIMITS.batch) return err(REJECT.TOO_MANY);
    for (const sub of c.c) {
      if (!sub || typeof sub.t !== "string" || sub.t === "batch") return err(REJECT.MALFORMED);
      if (!SCHEMA[sub.t]) return err(REJECT.UNKNOWN_TYPE);
    }
    return ok(c);
  }
  if (!SCHEMA[c.t]) return err(REJECT.UNKNOWN_TYPE);
  return ok(c);
}

/** Server side: apply ONE validated command against live state, as `owner`.
 *  Runs at the scheduled tick, immediately before tick(state, dt). */
export function apply(state, owner, command) {
  if (command.t === "batch") {
    // Atomic on VALIDATION: a batch is one client gesture resolved against one
    // observed state (inputCommands.js:90-96 fans a right-click into two calls).
    // If any member is invalid the client's disambiguation was wrong, so none apply.
    const results = [];
    for (const sub of command.c) {
      const r = SCHEMA[sub.t].run(state, owner, sub);
      if (!r.ok) return r;
      results.push(r.result);
    }
    return ok(results);
  }
  const entry = SCHEMA[command.t];
  if (!entry) return err(REJECT.UNKNOWN_TYPE);
  return entry.run(state, owner, command);
}

export const COMMAND_TYPES = Object.keys(SCHEMA);
```

**Note the batch caveat.** A batch validates-then-applies member by member, so a
member that fails *after* an earlier one already mutated state is not rolled
back. That is acceptable for the only batch we actually generate
(`aggressiveMove`'s two disjoint sub-selections, `inputCommands.js:94-95`), where
member 2's validity does not depend on member 1. If a future batch needs true
atomicity, validate all members against a dry-run resolver first, then apply —
but do not build that until something needs it.

---

## 5. Determinism of application order

### 5.1 The ordering rule

Commands arrive out of order from N clients over N sockets. The authoritative
total order is:

```
sort key = (applyTick, ownerIndex, seq)

  applyTick   integer, stamped by the server at admission (§5.2)
  ownerIndex  state.owners.indexOf(owner)  -- engine/state.js:227,
              "the world's side ids, in canonical iteration order"
  seq         the client's per-connection monotonic counter
```

This is a **total** order: `(owner, seq)` is unique by construction (duplicates
are dropped idempotently at admission), so no two records ever tie.

**Why `ownerIndex` and not arrival time.** Arrival time is wall clock; the
engine-purity guard forbids wall clock in the sim
(`test/engine-purity.test.js:16` bans `Date.now`), and more importantly a replay
must not depend on network jitter. `state.owners` is a stable, seed-independent
array that already drives every other owner-generic loop in the engine
(`state.js:269-270`, `sim.js`, `victory.js`).

**Why `seq` and not a content hash.** `seq` preserves the *client's own* intent
order, which is load-bearing: a player who queues `move` then `attackMove` on the
same units in the same tick means something different from the reverse.

**Fairness note.** `ownerIndex` gives seat 0 a systematic advantage in the rare
case of two players issuing conflicting commands in the same tick (e.g. both
right-clicking the last unclaimed node). This is a known, accepted asymmetry in
every lockstep RTS and is far smaller than the network jitter it replaces. If it
ever matters, rotate the ownerIndex offset by `applyTick % owners.length` — but
do not do this speculatively; it makes replay logs harder to reason about.

### 5.2 Where the tick stamp comes from

**The server stamps it. The client's `tick` field is never trusted.**

```js
const INPUT_DELAY_TICKS = 3;   // 150ms at 20Hz — covers typical RTT + jitter
applyTick = state.tick + INPUT_DELAY_TICKS;
```

Because the architecture is **server-authoritative** (not peer lockstep), the
server does not need clients to agree on a future tick — it only needs the choice
to be *recorded*. The stamp depends on wall-clock arrival, which is
nondeterministic during the live match but is written into the log, so replay
from the log is exact (§7). This is strictly simpler and more robust than
honouring a client-proposed tick, which requires rejecting late commands and
opens a "schedule everything at tick+1000" griefing vector.

`INPUT_DELAY_TICKS` exists so a command is visible to every spectator/relay
before it lands, and so the server can batch a tick's worth of input into one
sorted list. Set it to 0 and the protocol still works; set it to 3 and the
spectator stream can stay a whole tick behind the sim without stuttering.

### 5.3 Where in the loop

```js
/* server/matchLoop.js — the ONLY place a wire command reaches the sim. */
import { tick } from "../engine/sim.js";
import { apply } from "../net/commandCodec.js";

function ownerIndex(state, owner) { return state.owners.indexOf(owner); }

/** Pull every command scheduled at or before `state.tick`, order it, apply it,
 *  append it to the log, THEN advance the sim by one fixed step. */
export function stepMatch(match, dt) {
  const { state, pending, log } = match;

  const due = pending.filter(r => r.applyTick <= state.tick);
  if (due.length) {
    // A command whose tick has already passed (a slow admission, a resumed
    // socket) still lands here rather than being dropped — but it sorts by its
    // ORIGINAL applyTick, so the log stays monotonic and the replay is exact.
    due.sort((a, b) =>
      a.applyTick - b.applyTick ||
      ownerIndex(state, a.owner) - ownerIndex(state, b.owner) ||
      a.seq - b.seq);
    for (const rec of due) {
      const res = apply(state, rec.owner, rec.cmd);
      rec.result = res.ok ? res.result : { rejected: res.code };
      rec.appliedAtTick = state.tick;   // == applyTick in the normal case
      log.push(rec);
      match.emitAck(rec);
    }
    match.pending = pending.filter(r => r.applyTick > state.tick);
  }

  tick(state, dt);          // <- the sim advances AFTER every command for this tick
}
```

**Why before `tick`, never inside it.** `tick(state, dt)` opens with
`runAI(state, dt)` (`engine/sim.js:39-40`), which issues its own orders through
the same `issue*` functions. In single-player, DOM input handlers fire between
`update()` calls (JS is single-threaded; `createLoop`'s `update(dtFixed)` at
`engine/loop.js:55` runs to completion). So "commands land between ticks, before
the AI thinks" is *exactly* the existing single-player ordering. Applying them
mid-tick — e.g. after `runAI` but before movement — would be a behavioural change
with no justification, and would break the ability to validate the netcode path
against `tools/selfplay.js`.

**Rejected commands are logged too.** A rejection is a fact about the match
(anti-cheat forensics, and a spectator needs to know why nothing happened). It
carries no state mutation, so it does not affect replay — but it must be
*present* in the log for the log to be auditable.

### 5.4 The fixed step

The server must pick one `dt` and never change it. `tools/selfplay.js:42-57`
documents in detail why: *"A fixed step IS the simulation… dt 0.1 ended 'ai' by
elimination at 1138 s, dt 0.05 ended 'player' by elimination at 1686 s — opposite
winners."*

**Recommendation: `dt = 0.05` (20 Hz), matching `createLoop`'s default
(`engine/loop.js:34`) and ordinary play.** `SELFPLAY_DT = 0.1` exists for
throughput on the AI bench, not for fidelity. Record the chosen `dt` in the match
header (§7) so a replay cannot be run at the wrong step.

---

## 6. `state.selection`

### 6.1 Who reads it — the grep

`state.selection` is declared at `engine/state.js:231` as
`selection: []  // unit/building ids currently selected by the human player`, and
typed at `engine/types.js:335`.

**Readers — all UI, none in the sim:**

| File | Lines |
|---|---|
| `inputCommands.js` | `103`, `147`, `150`, `152`, `154`, `157`, `177`, `195`, `196`, `206` |
| `renderEffects.js` | `544`, `561`, `562`, `598`, `635` |
| `hudSelection.js` | `76` (and the whole panel-signature system downstream) |
| `render.js` | `132` |
| `techChart.js` | `258` |
| `boot.js` | `223` |

**Writers inside `engine/`:**

| File | Line | What |
|---|---|---|
| `engine/state.js` | `347` | `removeEntity` prunes the dead id out of `state.selection` |
| `engine/galaxy.js` | `1422` | `from.selection = []; dest.selection = []` on an interplanetary jump |

**No file under `engine/` ever READS `state.selection`.** It is written
defensively (so the UI never holds a dangling id) and read only by the client.
The brief's premise is confirmed.

### 6.2 Where it must move — and what stays

**Decision (D6): selection is per-client UI state and moves to the client
session. The `State` field stays, permanently empty, on the server.**

- **Client** (browser): `client/session.js` grows `selection: string[]`, owned by
  the input layer. `inputCommands.js`'s `applyBoxSelection` / `selectedUnits` /
  `commandAt` read it from there instead of from `state`. Every one of those call
  sites is already local to the client — this is a find-and-replace, not a
  redesign.
- **MCP agent**: an agent has no pointer and no box-select. Its "selection" is
  whatever id array it puts in a command. The MCP server should expose a
  *convenience* selection in the agent session (so an agent can say "select all
  my Lancers, then attack-move") but it must be an MCP-server concept, never a
  sim concept, and it must be re-validated by the codec on every command anyway.
- **Server**: `state.selection` stays as `[]` forever. Do **not** delete the
  field. `removeEntity` (`state.js:345-348`) is on the hot path of every death in
  the game; making it conditional, or removing the line, means touching
  `engine/state.js`, `engine/galaxy.js:1422`, `engine/types.js:335`, the
  persistence layer and any test that asserts on selection pruning — for a
  saving of one array filter over an always-empty array. Not worth it.

**Guard test:** assert that no file under `server/` or `net/` contains
`state.selection`, using the same directory-walk idiom as
`test/engine-purity.test.js:35-52`. That converts D6 from a convention into an
enforced invariant.

**One subtlety that must be carried across:** selection *order* is game input
(§3.3). `applyBoxSelection`'s Ctrl-click promote-to-front
(`inputCommands.js:150-152`) is how a player picks a formation leader. When
selection moves client-side, that ordering must still be what the client puts in
`cmd.ids` — otherwise leaders silently change and formations break.

---

## 7. Replay & spectator

### 7.1 Can a seed + ordered command log replay the match exactly?

**Yes — after B1 in §8 is fixed. Not before.**

The engine is built for this. `engine/rng.js:5-6` states the sim uses *"NO other
randomness (a determinism-guard test enforces it), so 'same seed ⇒ same game'"*,
`test/engine-purity.test.js:16` bans `Math.random`/`Date.now`/`performance.now`
across `engine/`, and `test/determinism.test.js:22-29` proves 2500 ticks replay
byte-identically from one seed.

### 7.2 What a replay file must capture

```jsonc
{
  "replayVersion": 1,
  "engineCommit": "50ceb88",              // MUST match; balance changes invalidate a replay
  "protocolVersion": 1,

  "sim": {
    "dt": 0.05,                            // §5.4 — a different step is a DIFFERENT GAME
    "createGameState": {                   // every argument of engine/state.js:154
      "planetId": "ferros",
      "seed": 12345,                       // feeds mulberry32 (engine/rng.js:24)
      "sizeMult": 1, "resourceMult": 1, "swapAsym": false,
      "matchTimeLimit": null, "popCap": null, "endless": false,
      "difficulty": "medium", "aiArchetype": null,
      "playerFaction": "…", "aiFaction": "…"
    },
    "postCreate": [                        // mutations applied AFTER createGameState returns
      { "fn": "seedDifficultyEdge", "owner": "p1" },   // engine/state.js:299
      { "fn": "createAiController", "owner": "p3", "opts": { "apm": 120, "micro": true,
                                                             "strategy": "default",
                                                             "difficulty": "hard",
                                                             "archetype": "…" } }
    ]
  },

  "seats": [ { "owner": "p1", "kind": "human",  "label": "alma" },
             { "owner": "p2", "kind": "agent",  "label": "mcp:claude-1" },
             { "owner": "p3", "kind": "ai",     "label": "scripted" } ],

  "commands": [ /* log records from §3.1, already in (applyTick, ownerIndex, seq) order */ ],

  "checkpoints": [ { "tick": 200,  "fp": "…" },   // tools/selfplay.js:157 fingerprint()
                   { "tick": 400,  "fp": "…" } ],

  "outcome": { "tick": 18342, "winner": "p1", "winReason": "elimination" }
}
```

### 7.3 What is easy to forget — and fatal if forgotten

1. **`dt`.** Covered above. Put it in the header and refuse to replay without it.
2. **Every `createGameState` option, not just the seed.** `sizeMult`,
   `resourceMult` and `swapAsym` all feed `generateMap` (`state.js:161-165`) and
   change the world.
3. **Post-`createGameState` mutations.** `seedDifficultyEdge` (`state.js:299`)
   writes `players[owner].upgrades.hardEdge` *after* construction, and
   `state.playerAi` is *"populated after createGameState, never by it"*
   (`types.js:340-341`). A replay that only records constructor args reproduces a
   different world. `tools/selfplay.js:36` already imports all three functions for
   exactly this reason — copy that pattern.
4. **AI seat configuration.** `{apm, micro, strategy, difficulty, archetype}` per
   AI seat (`tools/selfplay.js:69-74`). The scripted AI is a *player* in a replay
   and its dials are inputs.
5. **The rejected commands.** Keep them; they are audit evidence and they cost
   nothing to replay (they no-op).
6. **The engine commit.** A balance tweak in `entities.js` silently invalidates
   every stored replay. Refuse to replay across a commit mismatch rather than
   producing a plausible lie.
7. **Periodic fingerprints.** Reuse `fingerprint(state)`
   (`tools/selfplay.js:157-169`) verbatim — it already covers units (id, type,
   owner, x, y, hp, order type), buildings, per-owner resources, fog totals, both
   AI controllers, `tick`, `time`, `over`, `winner`. Store one every N ticks. On
   replay, a mismatch localises the divergence to an N-tick window instead of
   "somewhere in 20 minutes". For live play, comparing the server fingerprint
   against a client's own prediction is the desync canary.
   *Note:* `test/determinism.test.js:9-15` warns that a *weaker* local snapshot
   once masked real drift, and `test/_helpers.js`'s `entitySnapshot` is the
   stronger one. For stored checkpoints, prefer `entitySnapshot`; `fingerprint`
   is the cheap live variant.

### 7.4 Spectator

A spectator is a replay consumer with a live tail: subscribe to the same ordered
command stream plus periodic `entitySnapshot` keyframes, and run the identical
`stepMatch` loop locally. That gives full-fidelity spectating at command
bandwidth (a few hundred bytes/sec) rather than state bandwidth.

**Fog is the catch.** A spectator running the real sim has the *whole* state,
including every player's fog. Client-side fog filtering is not a security
boundary. Two honest options:

- **Deferred spectating** (recommended for v1): spectators are N seconds behind
  and receive the *stream*, but the relay withholds commands whose subject is not
  yet visible to the spectator's chosen POV. Simple, and matches how most RTS
  observers work.
- **Server-rendered POV**: the server maintains one fog-filtered state view per
  spectator POV and ships deltas. Correct, but expensive and a much bigger build.

Do not ship "full state, hidden by the client" — in a competitive ladder that is
a maphack with extra steps.

---

## 8. Blockers found — fix before the codec ships

### B1 — `nextEntityId` is a module-global (**critical**)

`engine/state.js:23-24`:

```js
let nextEntityId = 1;
function newId(prefix) { return `${prefix}${nextEntityId++}`; }
```

reset at `createGameState` (`state.js:155`). The comment at `state.js:17-22`
reasons that *"IDs are only ever compared within one state's own Maps, so two
live games sharing id strings is harmless"* — **true for two games, false for two
games in one process.** A single Node server hosting concurrent matches will
interleave `newId` calls across matches, so match A's units are minted
`u57, u59, u62…` depending on what match B did. Entity ids feed the
deterministic tie-breaks in movement/separation/gather/`rankSlotsByRange`
(`commands.js:105` sorts by `a.id < b.id`), so **the same seed and the same
command log produce a different match** depending on what else the server was
hosting. Replay, spectating and any ladder rating built on them are all invalid.

Worse, `createGameState` *resets* the counter to 1 — so starting match B
mid-match A makes A start minting ids that collide with its own live entities.

**Fix (small, surgical):** move the counter onto the state. Either
`state.nextEntityId` with `makeUnit`/`makeBuilding` taking `state`, or a
per-match id-minter closure passed into `createGameState`. The existing
`peekEntityId`/`restoreEntityId` pair (`state.js:29-31`) shows persistence already
treats it as per-game state — this makes that real. Guard with a test that two
interleaved `createGameState` runs each replay identically.

**Until this is fixed, run one match per Node process (worker/child process per
match).** That is a legitimate v1 shipping posture on a Hugging Face Space and
sidesteps B1 entirely — but write it down as a constraint, not an accident.

### B2 — formations are gated on `owner === "player"` (**critical**)

`engine/commands.js:155` (§1.4). In a multi-seat match no owner is literally
`"player"`, so `dispatchFormation` takes the AI branch for everyone and the
leader/follower squad system silently disappears.

**Fix:** replace the literal test with a state-level predicate — e.g.
`state.seats[owner]?.kind !== "ai"`, or a `humanControlled` flag set at match
creation. The comment block at `:147-154` explains the intent precisely ("there's
no analogous 'the unit you built a selection around' concept for the scripted
AI"), so the predicate is *seat kind*, not owner name. Small change, but it
changes AI-vs-AI fingerprints if done carelessly — gate it so the existing
`"player"`/`"ai"` two-owner world behaves byte-identically.

### B3 — `tick` hardcodes two fog owners (**high**)

`engine/sim.js:70-71`:

```js
updateFog(state, state.fog, "player");
updateFog(state, state.fogAI, "ai");
```

`state.fogs` is already a per-owner map (`state.js:189`, `types.js:336`) and
`createGameState` iterates `owners` correctly (`state.js:269-270`) — but the tick
loop does not. Seats 3+ get no fog updates at all. Fix by iterating
`state.owners`. `test/ownerScaffold.test.js` exists and is the right place to
extend. (`engine/victory.js`, `engine/diplomacy.js` and `engine/galaxy.js` carry
similar two-owner assumptions — worth a dedicated audit, out of scope here.)

### B4 — `recycle.js`'s ownership comment is false (**doc bug, real risk**)

`engine/recycle.js:87-89` claims `issueRecycle` checks ownership. It does not
(`commands.js:444-450`). Fix the comment when the codec lands, or a future reader
will build on a guarantee that isn't there.

### B5 — explicit attack orders are friendly-fire capable (**medium**)

`engine/combat.js:46` takes `unit.order.targetId` with no owner filter and reaches
`performAttack` (`:85`) without one, while every *auto*-acquisition path does
filter (`:153`, `:243`, `:386`, `:411`). Harmless in single-player (the UI never
offers it, `inputCommands.js:247-251`). In multiplayer it is a team-griefing
vector and an own-goal footgun. Decide deliberately: either add the filter in the
codec (reject `attack` on a target whose owner is the submitter or an ally), or
in `combat.js`. **Recommend the codec** — keeping the engine byte-identical
protects the determinism baseline, and "can I shoot my ally" is a *rules* question
that belongs with the other rules the codec owns.

---

## 9. TDD hooks (the repo's house style)

The source repo is strict TDD with 2519 tests and a determinism guard. Land the
codec the same way:

| Test file | Asserts |
|---|---|
| `test/net-boundary.test.js` | Only `net/commandCodec.js` imports `engine/commands.js` from outside `engine/`. Directory-walk idiom from `engine-purity.test.js:35-52`. |
| `test/commandCodec-ownership.test.js` | For **every** entry in `COMMAND_TYPES`, a command naming another owner's entity returns `NOT_OWNER` and mutates nothing. Table-driven over `COMMAND_TYPES` so a new command type cannot be added without an ownership test. |
| `test/commandCodec-fog.test.js` | Foreign unit not visible ⇒ `NOT_VISIBLE`; foreign building explored-but-not-visible ⇒ allowed; undiscovered node ⇒ `NOT_VISIBLE`. |
| `test/commandCodec-schema.test.js` | Round-trip `encode`→`decode`; unknown type, bad version, oversized ids/pts/batch all rejected; **`ids` order is preserved** (the D4 guard). |
| `test/commandCodec-parity.test.js` | Driving a match through the codec produces the byte-identical `entitySnapshot` as driving the same orders through `issue*` directly. This is the proof that wrapping changed nothing. |
| `test/replay.test.js` | Seed + logged commands replay to an identical `entitySnapshot`; a one-tick shift in any `applyTick` diverges (proving the guard is real, mirroring `determinism.test.js:43-47`'s "different seeds diverge" check). |
| `test/matchLoop-order.test.js` | Commands submitted in scrambled arrival order apply in `(applyTick, ownerIndex, seq)` order; duplicate `(owner, seq)` is idempotent. |

---

## 10. Summary of recommendations

1. **Wrap `engine/commands.js` behind `net/commandCodec.js`.** Do not make the
   engine id-based. (§4.1)
2. **One engine signature change:** `issueSetRally(state, buildingId, x, y, nodeId)`. (§4.2)
3. **Server stamps `owner` and `applyTick`.** Never trust either from the client. (§3.1, §5.2)
4. **Order is `(applyTick, ownerIndex, seq)`; apply immediately before `tick(state, dt)`.** (§5)
5. **`ids` arrays are ordered input — never sort them.** (§3.3, D4)
6. **Add fog gating in the codec** — it exists nowhere in the engine. (§2.4, §3.5)
7. **`state.selection` moves to the client session; the field stays empty on the server.** (§6)
8. **Fix B1 (`nextEntityId`) before any concurrent hosting**, or run one match per
   process until it is fixed. (§8)
9. **Fix B2 (`owner === "player"` formation gate)** or multiplayer ships without
   formations. (§8)
10. **Cover both intent surfaces.** `engine/commands.js` is phase 1; the ~20
    cost-bearing mutators the HUD calls directly (`hudSelection.js:20-35`) are
    phase 2, through the same codec. (§1.6, §3.6)
