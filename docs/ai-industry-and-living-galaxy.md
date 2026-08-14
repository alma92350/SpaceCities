# Industrial AI + Living Galaxy — phased design

Goal (from the request): in Odyssey, **make the AI use the full new economy** —
reactors, generators, the factory + Plasma Rig chain, the Datacenter tech tree,
electrification — so a neighbour that *develops* is less desperate for the shrinking
surface ore and **may avoid war**. And make the galaxy feel **alive**: multiple AI
factions develop on their own worlds and **expand to other planets** over time.

Chosen scope (confirmed with the user):
- **AI economy:** *full industrial AI* (not just electrify) — it techs the whole chain.
- **Factions across planets:** *living-galaxy meta-layer* — worlds simulate their
  own AI faction; strong factions spread across the starmap. Each world you land on
  stays a **two-sided** fight (no N-side per-world rewrite). *(Shipped as the whole
  roster simulating at once; later bounded to the start seat plus a seeded draw of
  `BACKGROUND_WORLDS` — see `engine/galaxy.js` `backgroundWorldIds`. The claims sweep
  still spreads across the whole starmap, and a dormant world takes the colours it was
  claimed under when you finally jump there.)*

---

## 0. The blocker, and the enabling move

The recent finite-storage/haulage economy is **player-only**: `sim.js` auto-assigns
haul/service work only to `owner === "player"` workers, and the AI's `assignIdleWorkers`
only ever issues `gather`. So an AI-built **factory** never gets inputs carried in or
outputs carried off — its `input`/`store` buffers stay empty and it produces nothing.
Same for a rig (its `store` buffer never drains). Reactors are pointless without a
consumer.

**Enabling move — real AI logistics (true symmetry).** *(Originally shipped as an
`owner === "ai"` abstraction — factories/rigs drew inputs from and banked outputs to
`players.ai.resources`, bypassing the buffers — so the AI paid no logistics labour. An
architecture review flagged that as an uncompensated asymmetry: the finite-storage/
haulage system, the headline Odyssey reshape, was a tax only the human paid. It was
then replaced by true symmetry, below, and the abstract branch deleted.)*

The AI now runs the **exact same** finite-buffer + worker-haulage model as the player.
`engine/ai.js` `assignAiLogistics` dedicates a **bounded share** of the AI's idle
workers (≤ half the pool, so gathering never starves) to `assignService`/`assignHaul` —
the same owner-generic machinery (`engine/haul.js`) the player's workers use — so an AI
factory only runs once workers have supplied its `input` larder and kept its `store`
buffer clear, stalling otherwise, and a rig's buffer must be hauled off. The AI's worker
target grows with its factory/rig count (it builds the labour its industry needs), and
`pickBuilder` leaves logistics workers alone. So the AI pays the same labour cost the
player does; there is **no owner special-case** in `updateProduction`/`updatePlasmaRig`,
and a **skirmish** never instantiates a factory so its replay is untouched. Perf-safe:
servicing is the same cheap movement the AI's gatherers already do (measured < 0.5 ms/
frame for the whole 11-world living galaxy).

---

## 1. Full industrial AI (`engine/ai.js`)

A new `aiIndustry(state, ctx)` phase, Odyssey-only, running after `aiBaseAndTech`.
Everything is APM-budgeted (`canAct`/`spend`), reserve-aware (`canAffordKeeping`), and
gated so only an archetype that *wants* to develop goes deep (a Rusher still rushes).

- **Power** — build a Reactor once there's a base + Barracks and the AI intends to run
  any power consumer; add a Combustion Generator on a world that deposits gas/biomass
  (cheaper power where it can be fuelled). Sized to draw: enough capacity that its
  factories aren't perpetually throttled.
- **Electrify** — flip `electrified` on the Barracks / CC / Habitat once a Reactor is
  up (30% faster unit production, +30% supply). A pure win for its core army economy,
  needs no factory chain.
- **Factory chain** — Smelter (ore→metals), a Datacenter, then research the tech path
  (`metallurgy → electronics → machining → antimatter → aicores`) and raise each deeper
  factory as its node unlocks (Assembler, Chip Fab, Machine Works, Antimatter Forge, AI
  Foundry, Torpedo Works). Ore-costed frames; the research is crystal/radioactive-costed,
  so a world's deposits gate how deep its AI can climb.
- **Capital path** — once the chain yields the strategic goods (`ai` cores, `plasmatorp`),
  build a **Star Dock** and field **Leviathans** (`{ore, ai, plasmatorp}`) — a real
  capital ship in its army. A **Plasma Rig** (`{ore, machinery, electronics, ai}`) for
  unlimited ore where it can afford the high-tech frame.

Emergent, not scripted: only a patient/rich neighbour (Economist worlds; Kybernet's
tech-10, Forge's industry-8) climbs far; a lean world's AI just electrifies and fields
a stronger core army.

---

## 2. Diplomacy — development keeps the peace (`engine/diplomacy.js`)

War onset today is scarcity-driven: `target = 0.6 − depletion*1.6`. Add a
**development** term: a neighbour investing in its own industry (reactors, factories,
rigs, research) is self-sufficient, not fighting you for the last surface seam, so its
war target is **softened** by how developed it is. A well-developed neighbour coexists
markedly longer at the same depletion; a bare strip-miner still turns on schedule.
Bounded so development can *delay/avoid* war, never force permanent unconditional peace
(the finale/Gate clause still overrides, unappeasable).

---

## 3. Living galaxy (`engine/galaxy.js`)

- **Every world simulates.** `createGalaxy` instantiates *all* `ODYSSEY_WORLDS` as
  `unsettled` background states, each with its own AI faction that founds a base and
  develops via §1. The BG scheduler already spreads background work round-robin; verify
  perf at the full roster and fall back to progressive activation if needed.
- **Factions expand across planets.** A developed AI world periodically dispatches a
  colony to an **adjacent unclaimed** world, spreading its faction across the starmap
  over time (galaxy-level faction territory). Each world stays two-sided when the player
  lands; "expansion" is a meta-event that seeds/strengthens the neighbouring world's
  faction presence and shows as territory on the starmap.

Determinism throughout: pure integer/seed math, no wall-clock, no unseeded RNG; the
byte-identical skirmish replay and the two-key `state.players` shape are untouched.

---

## Phasing (each phase: tests + tsc + browser-verify + commit + merge)

1. **Abstracted AI logistics** — the enabling core change (industry.js, rig.js).
2. **AI power + electrify** — the `aiIndustry` phase, first slice (ai.js).
3. **AI factory chain + research** — Smelter, Datacenter, tech path, deeper factories.
4. **AI capital path** — Star Dock/Leviathan + Plasma Rig.
5. **Diplomacy: development keeps the peace** (diplomacy.js).
6. **Living galaxy: all worlds simulate** (galaxy.js) + perf.
7. **Factions expand across planets** + starmap territory.
