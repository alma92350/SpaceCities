# Total Domination — a conquest playbook for Odyssey (Hard · Gigantic · Abundant · Pop-200)

A strategy for reaching the **`domination:all`** milestone — pacifying all 11 worlds — under the
toughest settings the setup screen currently offers: Difficulty **Hard**, Map size **Gigantic**
(4×), Resources **Abundant** (1.5×), Population cap **200**.

Every mechanical claim below is sourced from the engine (`engine/galaxy.js`, `engine/diplomacy.js`,
`engine/aiArchetypes.js`, `engine/aiDifficulty.js`, `engine/aiStrategy.js`, `engine/supply.js`,
`engine/map.js`, `engine/state.js`, `engine/combat.js`), cross-checked against
`docs/player-handbook.html`, and where noted, against real `node tools/ailab.js probe` runs — see
the Appendix for the exact reproduction commands. This is a strategy document, not an engine
change: nothing in `engine/` or `tools/` is touched.

---

## TL;DR

1. **You cannot permanently lose.** `checkGalaxyRescue` (`engine/galaxy.js`) re-seeds a free colony
   ship if you're ever wiped everywhere. The only real ending is a deliberate surrender. So "hardest
   AI" mostly threatens *tempo* — how long it takes, how much it costs — never the outcome.
2. **"Conquer all 11" is `checkDomination` hitting `galaxy.pacified.size >= galaxy.worlds.length`.**
   Pacifying a world = razing its neighbour's Command Center while it has no colony ship left to
   re-found with. Pacification is **permanent and sticky** — you do **not** need to hold or garrison
   a world afterward for it to stay conquered.
3. **But the galaxy's clock never pauses for you.** Part of it simulates from galaxy creation, not
   from when you personally arrive: `createGalaxy` starts your seat plus a **seeded, pseudo-random
   draw of 3 other worlds** (`BACKGROUND_WORLDS`/`backgroundWorldIds` — which three is part of what
   the galaxy seed means), and `stepGalaxy` ticks each of those every frame at a coarser cadence
   that conserves the same total sim-time. The rest of the roster stays **dormant** and is
   generated the moment you jump there — pristine, exactly as if the galaxy had just been created —
   and then simulates from that point on, like any world you've left. So time spent perfecting your
   capital is time the *live* neighbours get to grow; an unvisited dormant world is the one place
   patience really is free. You can't see which is which from the starmap, so plan for the worst.
4. **Only your start world's neighbour is guaranteed Hard.** The other ten get an *independently
   randomised* difficulty and strategy per world (`neighbourAiProfile`, keyed off the galaxy seed).
   Scout before you commit fuel — Observer Mode is free and shows you exactly what you're facing.
5. **Build one veteran strike force at a fortified capital; don't try to hold 11 fronts.**
   Kills-based veterancy is stamped on the unit and travels with it across jumps. **Doctrine
   research does not** — it lives on `state.players.player.upgrades`, which is freshly empty on
   every planet's own game state. A travelling task force fights at base stats wherever it lands.
   Raw mass, composition and siege picks matter far more than teching combat doctrines for the road.
6. **The 200 population cap is shared and identical for both sides, on every world.** Real probe
   data below shows an unattended Hard-difficulty Balanced or Economist neighbour can independently
   grow to 150–230+ supply of standing army within 30–50 minutes if left alone — don't dawdle on
   those. Rusher worlds self-bottleneck. Technologist (Kybernet) is the softest target in the whole
   roster if you hit it early.
7. **Stack Spaceports.** Jump capacity is per-pad (12/24/40 supply at tier 1/2/3) but *additive
   across every completed pad on the launching world* — three tier-1 pads move as much as one
   tier-3 pad, for a third of the ore.
8. **Watch for a rival Gate.** On Hard, *any* archetype is eligible to race its own Antimatter Gate
   once it reaches the Strategic tier and banks a real stockpile. It's rare, but it's the one thing
   in this mode that can hand a neighbour a permanent upgrade and lock its stance at Wary forever.

---

## 1. What you're actually being asked to do

`DOMINATION_TARGET = 4` (`engine/galaxy.js`) fires the "Domination" firework at 4 pacified worlds;
the campaign this document is for is the harder milestone one line below it:

```js
if (galaxy.pacified.size >= galaxy.worlds.length) reachMilestone(galaxy, "domination:all");
```

`galaxy.worlds` is the fixed 11-world roster (`ODYSSEY_WORLDS` = the 9 skirmish worlds + Kybernet +
Verdani). A world becomes pacified — permanently — the instant `checkDomination` samples it with
no AI Command Center **and** no AI colony ship in hand:

```js
const hasAiCommand = state => {
  for (const b of state.buildings.values()) if (b.owner === "ai" && b.type === "command" && !b.constructing) return true;
  return hasColonyShip(state, "ai");
};
```

Two consequences worth planning around:

- **Kill the colony ship, not just the Command Center.** If the neighbour still has an undeployed
  ship in hand when you raze its CC, `aiFoundOrSurvive` can re-seat a new base from it before the
  ~1-second `checkDomination` scan catches the gap. Scan the area for a stray colony ship before you
  leave a "conquered" world — it costs nothing to double-check and it's the one way a razed world
  can bite you back.
- **You don't have to hold it afterward.** Once `galaxy.pacified` has the id, `checkDomination`
  `continue`s past it forever — no re-check, no way to un-pacify it, even if you later abandon every
  building there. This is what makes a hit-and-run campaign viable instead of an 11-front occupation.

And per `docs/odyssey-ai-review.md` §2.5, a wiped neighbour genuinely cannot rebuild without a
colony ship in hand — this isn't a race condition you're exploiting, it's the intended conquest
mechanic (`galaxy.pacified`, its own toast and firework).

---

## 2. What "hardest current AI" really means — and its one blind spot

`DIFFICULTY_OPTIONS` (`engine/aiDifficulty.js`) has exactly three entries; Hard is the ceiling:

| | APM | Micro | Worker mult | Grace mult | Grievance mult | Research pace | Market | Rusher graduates | Forgiveness | Counter-picks every |
|---|---|---|---|---|---|---|---|---|---|---|
| Easy | 20 | off | 0.8× | 1.15× | 0.85× | 1.3× (slower) | no | no | 1.25× | never |
| Medium | 65 | off | 1× | 1× | 1× | 1× | yes | no | 1× | 3rd unit |
| **Hard** | **140** | **on** | **1.25×** | **0.9×** | **1.15×** | **0.75× (faster)** | **yes** | **yes** | **0.8×** | **2nd unit** |

Hard also starts with a synthetic `hardEdge` upgrade baked in at world creation (+10% gather, −10%
build/train — `engine/state.js`), on top of everything difficulty already buys: focus-fire, kiting,
a dedicated scout, feint resistance, worker raids, and — every third wave — a strike at your worker
line instead of your base if it can see one.

**The blind spot:** picking Hard at setup only guarantees Hard on the world you *start* on.

```js
const profile = planetId === galaxy.activeId
  ? { difficulty: s.difficulty, aiApm: s.aiApm, aiMicro: s.aiMicro, aiStrategy: s.aiStrategy }
  : neighbourAiProfile(galaxy.seed, planetId);
```

Every one of the other ten worlds draws its own difficulty *and* AI Strategy uniformly at random
from a seed-derived stream (`neighbourAiProfile`, `engine/galaxy.js`) — in expectation that's
roughly 1-in-3 Hard, 1-in-3 Medium, 1-in-3 Easy, crossed with a 1-in-4 pick among
Adaptive/Aggressive/Economic/Force Parity, **independently per world**. Across 11 worlds, expect
something like 3–5 genuinely Hard neighbours, not 11 — but you cannot know which ones without
looking (§7 covers how to look for free).

The **AI Strategy** setup row (Adaptive/Aggressive/Economic/Force Parity) has the identical
scope limit — it only sets your start world's neighbour. If you want your first fight to also be
the single hardest *reachable* combination, pick **Aggressive**: it composes with Hard
multiplicatively on the grace/grievance dials (`engine/diplomacy.js effectiveDiplomacyMults`), and
per the handbook it commits a wave 45% sooner with only 60% of its normal muster and 40% of its
home guard — the shortest fuse in the game, though also, not coincidentally, the easiest of the
four strategies to punish for overcommitting. Force Parity or Economic on Hard gets you a start
neighbour that builds a *real* defense and simply never swings first — arguably the tougher nut to
actually crack, just a quieter one while you're doing it.

---

## 3. What the four settings change, precisely

| Setting | Value | What it actually touches |
|---|---|---|
| **Map size: Gigantic** | `sizeMult = 4` | Map is 6400×4000 (vs. 1600×1000 Small); 26 hidden caches instead of 8; one extra mirrored belt of full-size deposit clusters in the contested middle per size step above Small. **Home ore is exempt from size** — always exactly 3 fixed-distance nodes, so the opening is identical regardless of map size. Travel time for everything (your jump-load staging, the AI's own expansion/offense marches) scales up a lot. |
| **Resources: Abundant** | `resourceMult = 1.5` | Every deposit's *amount* (not gather rate) is scaled ×1.5, both sides, on all 11 worlds — including home ore: `amountOf(350) = round(350 × 1.5) = 525`/node, so 3×525 = **1,575** home ore, not 1,050. Mining rate stays fixed at 10/s/worker, so bigger deposits take proportionally longer to reach the *same depletion fraction* — since `diplomacy.js`'s scarcity-driven war target reads `1 − cur/max`, Abundant buys **more peaceful build-up time before scarcity-driven hostility** on every world. It does **not** delay the unconditional late-game creep (`CREEP_RATE`, pure elapsed time past the 7-minute grace) or the Gate-charging endgame override. |
| **Population cap: 200** | `state.popCap = 200` | A hard ceiling on `buildingSupplyCap`, applied identically to **both owners, on every one of the 11 worlds** (`engine/supply.js supplyCap` — `Math.min`, never asymmetric). Neither side can out-Habitat their way past it. This is the one setting that bounds the AI's own worst-case army size for you — see §8 for what that ceiling looks like in practice. |
| **Difficulty: Hard** | see §2 | Only guaranteed on your start world; independently randomised elsewhere. |

None of these interact with `DOMINATION_TARGET`, `PEACE_THRESHOLD`, `JUMP_COST`, or any of the
diplomacy constants — those are flat, not scaled by map/resource settings.

---

## 4. The core thesis

Three facts compose into one shape of play:

- No clock, no permanent defeat (§1) → patience costs nothing *directly*.
- But the neighbours on the galaxy's *live* worlds — your seat plus the seeded three, plus every
  world you've since visited — have been developing at conserved total sim-time whether you went
  back or not (§1, §8) → patience is not free *indirectly*: an ignored Hard/Balanced or
  Hard/Economist world keeps compounding, and you can't tell from the map which worlds those are.
- Veterancy travels with a unit (`unit.kills`, read live by `rankMults`); doctrine does not — it's
  `state.players.player.upgrades`, freshly `{}` on every planet's own `createGameState` call, and
  `engine/combat.js` reads it off **whatever world the fight is currently happening on**, never
  wherever the unit was built. A unit that jumps to virgin territory fights at base stats no matter
  what you researched at home.

Put together: **build one strong, veteran, siege-capable task force at a fortified capital hub, and
run a hit-and-run campaign** — jump out, kill the Command Center (and any colony ship), jump home
free, heal/reinforce, jump out again. Don't try to hold and defend 11 simultaneous fronts, and don't
bother teching combat doctrines for a force that's about to leave the world where it's useful.
Doctrine research earns its keep on worlds you're *settling and keeping*, not on the road.

---

## 5. The opening

Deploying the starting Colony Ship is instant and free — a Command Center plus 3 workers
(`COLONY_SHIP_WORKERS`), on the spot it's standing. From there, a standard economic opening scaled
for Abundant/Gigantic:

1. **Saturate home ore first.** 3 nodes × 525 (Abundant) support 3 full-rate miners each before the
   40%-efficiency overcrowding penalty bites (`minerSoftCap`) — 9 workers is the natural ceiling on
   home ore alone. Push a couple of Rangers (45 ore, 340 sight, all-terrain) out immediately to find
   the Gigantic map's extra contested-belt clusters and hidden caches early; on a 6400×4000 map they
   are much farther out than Small, and finding them sooner is pure upside with no cost.
2. **Barracks + Foundry early, Refinery once you're settling for real.** You need Foundry for
   Lancer/Breacher/Mender and for the Spaceport itself (`Spaceport` requires Foundry). Hold the
   Refinery (and its doctrine research) for your capital specifically — see §4 on why it doesn't
   help a travelling force.
3. **Spaceport as soon as you can afford it (600 hp / 300 ore / 30s).** This is the single highest-
   leverage building in the game for this objective — nothing else unlocks jumping. Don't wait for a
   "complete" economy first; a tier-1 pad (12 supply/jump) is still capacity for a real opening raid
   against the roster's softer worlds.
4. **First strike force: Bastion/Lancer core + a couple of Breachers, off the triangle math.**
   Skiff beats Lancer (+10), Bastion beats Skiff (+10), Lancer beats Bastion (+20, the sharpest
   swing in the triangle) — a mixed core means no single Hard-difficulty counter-pick (which
   re-evaluates every 2nd unit built) invalidates your whole army. Breachers strip buildings (150
   range, +30 building bonus) but are the worst anti-unit unit in the game (10 dmg/2s) — always
   escorted, never sent alone, and they auto-prefer a building target the instant one's in range so
   they don't need to be babysat once the escort has cleared the field.

Don't over-invest in perfecting this before making contact — see §8 on why elapsed time has a real
cost even though losing doesn't exist.

---

## 6. The capital hub and the travelling task force

- **Pick (or promote) one world as your Capital.** `upgradeToCapital` (400 ore) doubles a Command
  Center's HP and makes it permanent — the one base that never travels even conceptually. Research
  your doctrine here (Assault is the natural pick for a conquest-paced campaign — full stack is
  +52.1% damage dealt, multiplicative across all three tiers, not the +45% the tooltips suggest) so
  that anything *defending the capital* — reinforcements in transit, a garrison answering a
  counter-wave — fights buffed. It does nothing for units that have already jumped off-world.
- **Stack Spaceports at the capital.** Capacity is per-pad (12/24/40 at tier 1/2/3,
  `SPACEPORT_CAPACITY`) but `jumpManifestAll` sums *every* completed pad on the launching world in
  one jump. Three tier-1 pads (900 ore total) move 36 supply per jump for less than one tier-2
  upgrade; two tier-3 pads move 80. Pick whichever mix suits your ore income — the capacity is
  additive either way.
- **Jumping to anywhere you've already discovered or hold a foothold on is free.** Only a genuinely
  new destination costs fuel (`jumpCost`: `round(400 × tierDiscount × (0.8 + dist/18))`, roughly
  340–650 credits before the tier discount, 15%/30% off at tier 2/3). This is what makes
  hub-and-spoke economical: scout a world once (fuel), raid it, jump home free, reinforce, jump back
  out free.
- **Veterancy is the one thing that compounds for free.** Every confirmed kill is permanent
  (3/8/18-kill thresholds, up to +19.1% damage dealt / −16.9% damage taken at rank III), survives
  repair, and rides along on every jump because it's stamped on the unit object itself. A core task
  force that survives multiple campaigns gets measurably stronger without any further investment —
  pull a bloodied army home to heal between strikes rather than rebuying it fresh each time.
- **Composition for cracking a defended base:** a Bastion/Lancer core to hold the field and answer
  whatever the Hard AI counter-picks into, a Breacher detachment (escorted) to bring down the
  Command Center and any turrets once the field is clear, and — once you have an Arsenal —
  Dreadnoughts or a Colossus for raw building damage per supply point. Avoid a monoculture army:
  Hard re-evaluates its counter-build every 2nd unit and specifically answers massed
  Breacher/Dreadnought/Wraith/Colossus with massed Skiffs, and massed Aegis with Lancers.

---

## 7. Scouting for free, and a sequencing route

**Observer Mode (`O`) costs nothing** — no fuel, no Spaceport, no change to your real seat — and
its stats panel reads a spectated world's archetype, strategy, diplomatic stance, army composition,
buildings, supply and resources directly. Use it before every jump that would cost fuel: there is no
reason to pay for a blind trip when you can check the target's temperament and difficulty for free
first.

The 11 worlds lay out along a fixed x-axis (`data.js`), which is what `jumpCost` actually measures
distance on:

| World | x | Archetype | Tech rating |
|---|---|---|---|
| Glacius | 2 | Balanced | 3 |
| Ferros Prime | 3 | Economist | 3 |
| Verdani | 5 | Balanced | 4 |
| Helix Belt | 6 | Economist | 4 |
| Pyralis | 7 | Balanced | 5 |
| Kybernet | 8 | Technologist | 10 |
| Nimbus | 9 | Rusher | 5 |
| Forge Station | 11 | Economist | 6 |
| Korrath | 14 | Rusher | 2 |
| Oort Reach | 15 | Rusher | 2 |
| Vesper | 17 | Balanced | 4 |

Whichever world you start on, a route that sweeps this line in one direction (rather than
zig-zagging) minimizes total fresh-world fuel spend, since `jumpCost` scales with distance from
your *current* world, not from any fixed origin. §8 below is what should actually decide the order
within that sweep.

---

## 8. Per-archetype playbook — backed by real probes

The temperament table (`engine/aiArchetypes.js` / handbook §10) gives you the AI's *design* intent.
What it actually does over a real 30–60 minute session, on Hard, against a genuine attacking
opponent, is a different — and more useful — question. The rows below are real
`node tools/ailab.js probe` runs (default map size/resources, one representative seed; commands to
reproduce are in the Appendix). Read them as **evidence for sequencing, not exact minute-marks** —
Gigantic's travel time and Abundant's slower depletion will shift the absolute numbers, but the
relative ranking between archetypes is a property of their own worker/army/expansion targets, which
none of the four settings touch.

| Archetype | Design (workers / wave / cadence / turrets) | What actually happened on Hard | Verdict |
|---|---|---|---|
| **Rusher** (Korrath, Nimbus, Oort) | 4 / 4 / 90s / 0 turrets, never expands, never teches | vs. an attacking sparring bot: army grew to 31 by minute 30, but `dev` stayed pinned at 1 and it tripped its own supply-deadlock/production-stall detectors — it's a real fight but a *contained, self-bottlenecking* one that doesn't get more dangerous the longer you leave it. | Clear at your leisure. Doesn't punish a delay much, but doesn't reward one either. |
| **Economist** (Ferros, Helix, Forge) | 8 / 9 / 200s / 2 turrets, expands below 40% field | vs. a Foundry/Arsenal-teching attacker: army was 60 by minute 30 and **201 by minute 48**, then plateaued (naturally hit a ~200-supply ceiling on its own building count, before any explicit pop cap) while its bank kept climbing — a real, large, well-defended standing army if you let it cook. | Don't leave one unattended past ~30 minutes of galaxy time if you can help it. |
| **Balanced** (Glacius, Verdani, Pyralis, Vesper) | 6 / 6 / 150s / 1 turret, expands below 25% | The single fastest, cleanest snowball measured: **234 army by minute 30 and still climbing**, zero health-check defects fired (a genuinely healthy economy, not a stalling one). | The archetype most worth hitting *before* it's had a long, unattended window — it out-scales even the Economist in this sample. |
| **Technologist** (Kybernet only) | 7 / 7 / 220s / 2 turrets, expands below 30%, the only Colossus-fielder | Collapsed to **0 workers/army/buildings between minute 6 and minute 8** against the same class of attacker that the Economist and Balanced worlds shrugged off, and — per §1 — a wipe with no colony ship in hand is permanent. | Counter-intuitively the *softest* target in the roster despite the "elite tech capital" flavor text. Hit it early; it folds fast and stays down. |

The practical sequencing this supports: **Kybernet first if it's reachable early** (cheap, fast,
permanent), Rusher worlds whenever convenient (they don't get worse with time), and don't let a
Balanced or Economist world — especially if Observer Mode shows it's Hard — sit unvisited for the
whole first hour of galaxy time.

---

## 9. Diplomacy while campaigning

A neighbour's stance only gates its *offense* — it still builds, defends, and drifts diplomatically
regardless of stance. Numbers from `engine/diplomacy.js`:

- **7-minute opening grace** (`GRACE_TIME = 420s`, floored at Cordial) on every world, composed with
  archetype/strategy/difficulty multipliers but bounded so it can never compress below 168s
  (`MIN_GRACE_FRAC = 0.4`) no matter how you stack Hard + Aggressive.
- **Provocation is what lets a `neverInitiates` neighbour (Economic/Force Parity strategy) answer
  you at all** — destroying its ships, or charging your own Gate. It fades after
  `300s / forgiveness` of quiet, and every fresh loss re-arms the clock. This means an
  Economic/Force-Parity-strategy world you're actively sieging *will* fight back once you've drawn
  blood, even though it would never have swung first.
- **Tribute** (200 credits, ×1.55 steeper each time on the same world) snaps a souring neighbour back
  to Neutral for 120 seconds — useful to buy a quiet flank while your task force is committed
  elsewhere, not a long-term fix.
- **Gifts** build toward Allied (capped at 0.8, decaying over ~4 minutes without upkeep) if you'd
  rather trade with a world than fight it for now — irrelevant to the domination objective itself,
  but a legitimate way to neutralize a flank you're not ready to hit yet.
- **Faction echo**: pacifying one world knocks every *other still-unpacified* world of the same
  faction down by a flat 0.2 stance, once, with slower recovery for 180 seconds
  (`FACTION_ECHO_PENALTY` / `FACTION_ECHO_DURATION`, `engine/galaxy.js checkDomination`). A
  domination spree measurably sours the rest of that faction's worlds — expect the back half of your
  campaign to run hotter than the front half, independent of anything else you did.

None of this can stop you from winning a fight — it only decides whether the neighbour throws the
first punch. You are never required to wait for war; you can attack a Cordial world on turn one if
you're prepared to.

---

## 10. The one real hazard: a neighbour's own Antimatter Gate

`rivalGateEligible` (`engine/aiIndustry.js`):

```js
if (df.strategicCeiling) return false;                 // Easy can never reach this
if (!prereqsMet(state, "ai", BUILDINGS.antimatter_gate)) return false;   // Strategic tier standing
if (banked < RIVAL_GATE_BUFFER) return false;           // 30 combined AI cores+antimatter+plasma torpedoes
return df.mult === "hard" || wantsDeepIndustry(...);    // Hard ⇒ ANY archetype/strategy qualifies
```

On Hard, this applies regardless of temperament — not just to Economist/Technologist worlds. If a
neighbour's Gate completes, that faction claims every still-unclaimed, unheld world in the galaxy in
one burst, gets the same permanent economic edge Hard difficulty starts with (`hardEdge` — +10%
gather, −10% build/train), and its stance locks at Wary forever — with **no in-game toast warning
you as it climbs**. It doesn't block your conquest of that world
(claims don't gate `checkDomination`), but it does make that specific fight tougher and hands the
claimed worlds' starmap flags to a faction you didn't beat.

Mitigation is simple because Observer Mode is free: periodically check in on any world you know is
Hard difficulty with a patient archetype (Economist, Balanced, Technologist) or the Economic
strategy, especially ones you've deliberately deprioritized. If its industry panel shows the deep
chain (Antimatter Forge / AI Foundry / Torpedo Works) standing, move it up your list — razing the
Gate mid-charge costs the neighbour the whole investment, same as it would cost you.

---

## 11. Endgame and verifying total domination

- The starmap and `galaxyStatus()` expose `pacified` (count) against `dominationTarget` (4) — but
  the milestone you actually want is `domination:all`, which only fires at
  `pacified.size >= worlds.length` (11). There's no separate HUD counter for "11" specifically
  beyond the per-world pacified/contested/colony status on the starmap — track it by elimination:
  once every world reads `pacified` or you personally hold it, you're done.
- Order the last few kills by what's actually still standing, not by a fixed script — by the late
  game, faction echo (§9) and your own territory will have reshaped the diplomatic map enough that
  the "hardest" world left is whichever one you've been avoiding, not necessarily whichever
  archetype table says should be hardest.
- There is no rush at the end any more than at the start — a wipeout anywhere just costs a relief
  cooldown (`RELIEF_COOLDOWN = 20s`) before a fresh colony ship shows up. Finish methodically.

---

## 12. Quick-reference checklist

- [ ] Setup: Odyssey · Hard · Gigantic · Abundant · Pop cap 200. Pick AI Strategy for your *start*
      world knowing it only applies there (Aggressive = earliest fight; Economic/Force Parity =
      quietest but not necessarily easier).
- [ ] Deploy, saturate home ore (9 workers), scout with Rangers for the Gigantic map's extra belts.
- [ ] Barracks → Foundry → Spaceport. Don't over-polish the opening — the rest of the galaxy is
      aging in the background while you do.
- [ ] Stack a second/third Spaceport at your capital before your first big push; upgrade tiers only
      if ore is otherwise idle.
- [ ] Research Assault at the capital's Refinery — it buffs the garrison, not the road.
- [ ] Build a mixed Bastion/Lancer core + escorted Breachers; avoid a monoculture army against Hard's
      2nd-unit counter-picking.
- [ ] Observer Mode every world before you pay fuel for it. Route: Kybernet early if reachable, then
      sweep the x-axis, saving nothing Balanced/Economist for "later" if it's Hard.
- [ ] On each kill: confirm no AI colony ship is left in the area before you move on.
- [ ] Jump home free between strikes, heal, let veterancy compound.
- [ ] Check in on any deprioritized Hard/patient world periodically — free via Observer Mode — for a
      creeping industrial chain.
- [ ] 11/11 pacified → `domination:all`.

---

## Appendix: reproducing the evidence in §8

```
node tools/ailab.js probe --world korrath  --difficulty hard --opponent skirmisher --minutes 30 --sample 5
node tools/ailab.js probe --world ferros   --difficulty hard --opponent tech       --minutes 60 --sample 6
node tools/ailab.js probe --world vesper   --difficulty hard --opponent tech       --minutes 30 --sample 5
node tools/ailab.js probe --world kybernet --difficulty hard --opponent tech       --minutes 16 --sample 2
```

`--opponent tech` is a turtle economy that also teches Foundry/Arsenal and attacks with a
Lancer/Breacher/Dreadnought guard instead of a Skiff blob (`tools/ailab.js`) — a deliberately simple,
scripted sparring partner, not an optimal player. It is a *lower bound* on what a competent human
strike force can do to the same neighbour: where it already wins (Kybernet), a real player should
too, faster; where it stalemates or loses (Rusher/Economist/Balanced holding past 30 minutes), those
numbers say "this needs real mass and siege," not "this is unbeatable" — none of the four settings
in this document change any AI worker/army/expansion target, only the economy's absolute scale and
the shared population ceiling both sides answer to.

These probes run at default map size/resources (`ailab.js` doesn't currently expose
`sizeMult`/`resourceMult`/`popCap` as CLI flags — it's a single-world bench, not a galaxy
simulation). The archetype ranking they show is driven by each archetype's own worker/army/expansion
targets and its `wantsRefinery`/`wantsIndustryAlways` flags, none of which the four settings in this
document touch — which is why §8 treats them as evidence for *relative sequencing* rather than as
literal minute-marks for a Gigantic/Abundant/Pop-200 run.
