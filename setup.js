/* ============================================================
   The splash / map-select screen: the skirmish setup panel (difficulty,
   faction, map size, resources, seed) and the battlefield cards. Owns the
   shared `setup` config object that boot.js reads when it starts a game.
   The initial renderMapSelect() kickoff is called by main.js; the game-over
   "choose another battlefield" button (hud.js) re-invokes it via boot.
   ============================================================ */

"use strict";

import { mapSelectEl } from "./dom.js";
import { PLANETS } from "./data.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { archetypeFor, PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE } from "./engine/aiArchetypes.js";
import { STRATEGIES } from "./engine/aiStrategy.js";
import { DIFFICULTY_OPTIONS } from "./engine/aiDifficulty.js";
import { DEFAULT_MATCH_TIME_LIMIT } from "./engine/victory.js";
export { DIFFICULTY_OPTIONS };   // re-exported: boot.js and a few tests still import it from here
import { FACTIONS, PLAYABLE_FACTIONS } from "./engine/factions.js";
import { hasSave, loadGame, hasOdysseySave, loadOdyssey } from "./saveload.js";
import { APP_VERSION } from "./version.js";
import { startGame, startScenario, startRaider, startBounty, startOdyssey } from "./boot.js";
import * as sound from "./sound.js";
import { renderCompetition } from "./competitionScreens.js";

// The curated roster and its order both come from the AI archetype table, so
// the picker, the opponent temperament, and the tests all agree on one list.
// Exported: competition.js's world multi-select reuses this exact roster rather than re-deriving it.
export const MAP_CHOICES = Object.keys(PLANET_ARCHETYPE);

// Every world an Odyssey can start on: the skirmish nine PLUS the two Odyssey-only extras
// (engine/galaxy.js ODYSSEY_WORLDS builds the identical list the same way — kept independent
// here rather than imported, since setup.js is a UI-layer module and this is purely about
// which cards to draw, not the engine roster itself).
const ODYSSEY_START_CHOICES = [...MAP_CHOICES, ...Object.keys(ODYSSEY_EXTRA_ARCHETYPE)];

// Splash-screen game setup, carried across "choose another battlefield"
// restarts. sizeMult scales the map (map.js); resourceMult scales every
// deposit's amount; aiApm caps the opponent's actions per minute (ai.js).
// Exported: lobbyScreen.js's own host form (T-034) reuses these exact same three dials rather than
// redefining them, the same single-source-of-truth reason MATCH_LENGTH_OPTIONS below is exported.
export const SIZE_OPTIONS = [
  { label: "Small", mult: 1, note: "1600×1000" },
  { label: "Standard", mult: 2, note: "2× · room to expand" },
  { label: "Large", mult: 3, note: "3× · long game" },
  { label: "Gigantic", mult: 4, note: "4× · sprawling war" },
];
export const RESOURCE_OPTIONS = [
  { label: "Rare", mult: 0.6, note: "lean deposits" },
  { label: "Normal", mult: 1.0, note: "balanced" },
  { label: "Abundant", mult: 1.5, note: "rich deposits" },
];
// Skirmish-only (engine/victory.js's score-tiebreak clock; Odyssey has no clock at all, and a
// scripted scenario runs its own separate mission clock/budget instead). Every option is a real,
// finite override of DEFAULT_MATCH_TIME_LIMIT — never "unlimited" — so checkWinCondition's
// terminal-state guarantee (a defensive stall can't stretch to infinity, CONTRIBUTING) always
// holds. "Standard" is DEFAULT_MATCH_TIME_LIMIT itself, so picking it is byte-identical to today.
// Exported: competition.js's Gauntlet screen offers the identical three lengths for its live
// matches (docs/competitions-and-elo.md Phase 4) — reused rather than redefined, so a length can't
// exist in one picker and not the other.
export const MATCH_LENGTH_OPTIONS = [
  { label: "Quick", mult: 1200, note: "20 min" },
  { label: "Standard", mult: DEFAULT_MATCH_TIME_LIMIT, note: "40 min" },
  { label: "Marathon", mult: 3600, note: "60 min" },
];
// Population cap (engine/supply.js's popCap clamp): a hard ceiling on top of the building-derived
// supply cap, shared identically by both the player and the AI — a match rule, not a per-side
// dial. "Max" is null: today's always-uncapped-by-anything-but-buildings default, so picking it
// (the default pick, matching setup.popCap's own default below) changes nothing from before this
// option existed. Offered in both economy modes (skirmish + Odyssey) — a scripted scenario runs a
// fixed roster instead of open production, so it never queues against a cap to begin with.
// The 150 rung exists for FRAME RATE, not for balance, which is why it sits below what used to be
// the tightest option: the cap bounds both sides' armies AND the housing that feeds them (a
// Habitat stops going up once the raw building total reaches the ceiling — engine/aiEconomy.js's
// rawCapHeadroom), so it is the one dial that bounds total entity count directly. It earns its
// place now that a neighbour actually develops (docs/odyssey-ai-review.md §2.11): measured on a
// 60-minute ferros/aggressive Odyssey, an uncapped world reaches ~1,250 supply across ~170
// buildings, and at 150 the same world settles at a fraction of that.
export const POP_CAP_OPTIONS = [
  { label: "150", mult: 150, note: "lean economy — smoothest" },
  { label: "200", mult: 200, note: "tight economy" },
  { label: "250", mult: 250, note: "moderate economy" },
  { label: "300", mult: 300, note: "large economy" },
  { label: "Max", mult: null, note: "uncapped — housing is the only limit" },
];
// Playable factions for the setup picker — a passive-trait identity for your side
// (engine/factions.js). Each option's `mult` is the faction id, its note the short
// tagline of its edge. The AI's faction comes from the world's archetype instead.
const FACTION_OPTIONS = PLAYABLE_FACTIONS.map(id => ({
  label: FACTIONS[id].short, mult: id,
  note: { frontier: "faster · sees farther", miners: "richer · builds faster", syndicate: "hits harder · lean economy" }[id],
}));
// AI Strategy — orthogonal to the opponent's archetype/doctrine (which the world/planet card
// picks): whether and when it voluntarily attacks (engine/aiStrategy.js). Order matches STRATEGIES'
// own key order so "Adaptive" (today's pure archetype-driven play) stays the first/default pick.
// Unlike difficulty (which fans out into two separate aiApm/aiMicro dials via boot.js's
// difficultyDials), a strategy key IS already the value createGameState/createGalaxy want, so
// boot.js just forwards setup.aiStrategy straight through — no lookup table needed. Applies to
// both Skirmish and Odyssey (setup.js renderSetupPanel's `economy` gate, below).
export const STRATEGY_OPTIONS = [
  { label: "Adaptive", mult: "default", note: "plays true to its archetype" },
  { label: "Aggressive", mult: "aggressive", note: "attacks earlier, presses first" },
  { label: "Economic", mult: "economic", note: "turtles, then rearms if hit" },
  { label: "Force Parity", mult: "matching", note: "mirrors your army size" },
];
export const setup = { mode: "skirmish", difficulty: "medium", faction: "frontier", aiStrategy: "default", sizeMult: 1, resourceMult: 1, seed: null,
  startWorld: null,    // Odyssey: explicit start-world pick (a planet id), or null for the seed's own random draw
  swapAsym: false,     // skirmish: play the swapped half of an asymmetric world's matchup (Oort, Nimbus) — see engine/map.js opts.swapAsym
  matchTimeLimit: DEFAULT_MATCH_TIME_LIMIT,   // skirmish: Match length row (Quick/Standard/Marathon) — see engine/victory.js
  popCap: null };      // economy modes: Population cap row (150/200/250/300/Max) — see engine/supply.js

// The game modes the splash toggles between.
const MODES = [
  { key: "skirmish", label: "⚔ Skirmish", note: "Destroy the enemy base" },
  { key: "odyssey", label: "🌌 Odyssey", note: "Open world — settle and grow, endlessly" },
  { key: "escort", label: "🚚 Convoy Escort", note: "Protect freighters to the destination" },
  { key: "raider", label: "🏴‍☠️ Pirate Raider", note: "Raid the convoy before it escapes" },
  { key: "bounty", label: "⭐ Bounty Marshal", note: "Hunt pirate camps before the clock" },
  { key: "competition", label: "🏆 Competition", note: "Pit two AI configurations against each other" },
];

// The scenario modes that pick a world from the card grid (Odyssey lands on a
// random world instead, and skirmish is a normal match).
const SCENARIOS = ["escort", "raider", "bounty"];

// The two scenarios' splash copy — the setup-panel difficulty hint, the brief
// blurb above the cards, and the screen title/subtitle. Keyed by setup.mode.
const SCENARIO_COPY = {
  escort: {
    title: "Convoy Escort",
    diffHint: "Higher difficulty means heavier piracy, a leaner escort, a tighter clock and a smaller repair budget.",
    brief: "Shepherd four freighters across a multi-leg route to the destination gate. "
      + "Pirates raid each leg by its risk; dock at a station between legs to repair from your budget; "
      + "beat the mission clock. Score rewards freighters delivered, legs survived, risk faced, and budget saved.",
    subtitle: "Choose the route (world to cross)",
  },
  raider: {
    title: "Pirate Raider",
    diffHint: "Higher difficulty means a tougher, better-escorted convoy, a leaner raider fleet, and a higher kill quota.",
    brief: "You are the pirates. An AI convoy runs a multi-leg route for the gate under escort; "
      + "lie in wait, then dive past the escort to sink freighters. Hit the kill quota before the convoy "
      + "escapes or the clock runs out. Score rewards freighters sunk, escorts destroyed, and raiders left alive.",
    subtitle: "Choose the route (world to raid)",
  },
  bounty: {
    title: "Bounty Marshal",
    diffHint: "Higher difficulty means a leaner posse, more and tougher camps, a higher clear quota, and less time.",
    brief: "You are the law. Pirate camps are scattered across the sector, each marked with its bounty. "
      + "Lead your posse from camp to camp and clear your quota before the clock runs out — pick your targets "
      + "and your order carefully. Score rewards bounty banked, camps cleared fast, and posse left standing.",
    subtitle: "Choose the sector (world to hunt)",
  },
  odyssey: {
    title: "Odyssey — open world",
    diffHint: "Difficulty sets how fast and fiercely your neighbours expand — from a calm frontier to a hostile sector.",
    brief: "The open-world campaign. Land on a random world with a mobile colony ship — deploy it to found your "
      + "first Command Center, your relocatable capital — then build your economy beside your neighbours, in peace or "
      + "war. Expand by building more colony ships and deploying them; only a Command Center jumps between worlds (via "
      + "a Spaceport). No clock and no victory screen: you play on while a foothold stands.",
  },
};

// A one-of-N pick rendered as a row of buttons; clicking one selects it and
// stores its value via onPick. Exported: competition.js reuses this directly for its own
// Strategy/Difficulty rows rather than redefining the same button-group rendering twice.
export function optionGroup(current, options, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "opt-group";
  options.forEach(opt => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn" + (opt.mult === current ? " active" : "");
    btn.innerHTML = `<span class="opt-label">${opt.label}</span><span class="opt-note">${opt.note}</span>`;
    btn.addEventListener("click", () => {
      onPick(opt.mult);
      wrap.querySelectorAll(".opt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function renderSetupPanel(mode) {
  // Economy modes (skirmish + Odyssey) run a full base economy, so they get the
  // faction and resource dials; the scripted scenarios have neither.
  const economy = mode === "skirmish" || mode === "odyssey";
  const panel = document.createElement("div");
  panel.className = "setup";

  const diffRow = document.createElement("div");
  diffRow.className = "setup-row";
  const diffLabel = document.createElement("span");
  diffLabel.className = "setup-label";
  diffLabel.textContent = "Difficulty";
  diffRow.append(diffLabel, optionGroup(setup.difficulty, DIFFICULTY_OPTIONS, key => { setup.difficulty = key; }));
  panel.appendChild(diffRow);

  const hint = document.createElement("p");
  hint.className = "setup-hint";
  hint.textContent = mode === "skirmish"
    ? "Easy is slow and holds formation; Medium fights at a fair pace; Hard is fast and micros its army — it focus-fires, kites, and scouts with a Ranger."
    : SCENARIO_COPY[mode].diffHint;
  panel.appendChild(hint);

  // Faction and resources shape a base economy — offered in the economy modes
  // (skirmish + Odyssey), skipped in the scripted scenarios.
  if (economy) {
    const facHint = document.createElement("p");
    facHint.className = "setup-hint";
    facHint.id = "factionHint";
    // Filled now and on every faction pick, so the blurb tracks the selection.
    const renderFactionHint = () => { facHint.textContent = FACTIONS[setup.faction].blurb; };

    const facRow = document.createElement("div");
    facRow.className = "setup-row";
    const facLabel = document.createElement("span");
    facLabel.className = "setup-label";
    facLabel.textContent = "Faction";
    facRow.append(facLabel, optionGroup(setup.faction, FACTION_OPTIONS, key => { setup.faction = key; renderFactionHint(); }));
    panel.appendChild(facRow);
    panel.appendChild(facHint);
    renderFactionHint();

    // AI Strategy: how the OPPONENT plays, independent of which world/archetype it is —
    // Adaptive (today's behavior), Aggressive, Economic, or Force Parity (engine/aiStrategy.js).
    const stratHint = document.createElement("p");
    stratHint.className = "setup-hint";
    const renderStratHint = () => { stratHint.textContent = STRATEGIES[setup.aiStrategy].desc; };

    const stratRow = document.createElement("div");
    stratRow.className = "setup-row";
    const stratLabel = document.createElement("span");
    stratLabel.className = "setup-label";
    stratLabel.textContent = "AI Strategy";
    stratRow.append(stratLabel, optionGroup(setup.aiStrategy, STRATEGY_OPTIONS, key => { setup.aiStrategy = key; renderStratHint(); }));
    panel.appendChild(stratRow);
    panel.appendChild(stratHint);
    renderStratHint();
  }

  // Map size shapes both a skirmish and a scenario — a bigger map is a longer
  // convoy route / a wider sector to hunt, with the mission clock scaled to
  // match (engine/scenarios.js), so it's offered in every mode.
  const sizeRow = document.createElement("div");
  sizeRow.className = "setup-row";
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "setup-label";
  sizeLabel.textContent = "Map size";
  sizeRow.append(sizeLabel, optionGroup(setup.sizeMult, SIZE_OPTIONS, m => { setup.sizeMult = m; }));
  panel.appendChild(sizeRow);

  if (economy) {
    const resRow = document.createElement("div");
    resRow.className = "setup-row";
    const resLabel = document.createElement("span");
    resLabel.className = "setup-label";
    resLabel.textContent = "Resources";
    resRow.append(resLabel, optionGroup(setup.resourceMult, RESOURCE_OPTIONS, m => { setup.resourceMult = m; }));
    panel.appendChild(resRow);

    const popRow = document.createElement("div");
    popRow.className = "setup-row";
    const popLabel = document.createElement("span");
    popLabel.className = "setup-label";
    popLabel.textContent = "Population cap";
    popRow.append(popLabel, optionGroup(setup.popCap, POP_CAP_OPTIONS, m => { setup.popCap = m; }));
    panel.appendChild(popRow);
  }

  // Match length: skirmish only (see MATCH_LENGTH_OPTIONS above for why Odyssey/scenarios don't
  // get this row).
  if (mode === "skirmish") {
    const lenRow = document.createElement("div");
    lenRow.className = "setup-row";
    const lenLabel = document.createElement("span");
    lenLabel.className = "setup-label";
    lenLabel.textContent = "Match length";
    lenRow.append(lenLabel, optionGroup(setup.matchTimeLimit, MATCH_LENGTH_OPTIONS, m => { setup.matchTimeLimit = m; }));
    panel.appendChild(lenRow);
  }

  // Optional seed: leave blank for a fresh random map, or enter a seed (shown on
  // the seed chip / game-over screen) to replay the exact same world.
  const seedRow = document.createElement("div");
  seedRow.className = "setup-row";
  const seedLabel = document.createElement("span");
  seedLabel.className = "setup-label";
  seedLabel.textContent = "Seed";
  const seedInput = document.createElement("input");
  seedInput.type = "text"; seedInput.inputMode = "numeric"; seedInput.className = "seed-input";
  seedInput.placeholder = "random";
  seedInput.value = setup.seed != null ? String(setup.seed) : "";
  seedInput.addEventListener("input", () => {
    const v = seedInput.value.trim();
    const n = Number.parseInt(v, 10);
    setup.seed = (v === "" || Number.isNaN(n)) ? null : (n >>> 0);
  });
  seedRow.append(seedLabel, seedInput);
  panel.appendChild(seedRow);

  return panel;
}

// Which start function each scenario mode boots. Skirmish is handled separately.
const SCENARIO_START = { escort: startScenario, raider: startRaider, bounty: startBounty };

export function renderMapSelect() {
  if (!mapSelectEl) return;   // import-safe under Node (CONTRIBUTING: follow the dom.js idiom)
  const isScenario = SCENARIOS.includes(setup.mode);
  const odyssey = setup.mode === "odyssey";
  const copy = SCENARIO_COPY[setup.mode];   // defined for scenarios + Odyssey; undefined for skirmish
  mapSelectEl.innerHTML = "";
  const title = document.createElement("h2");
  // Competition isn't in SCENARIO_COPY (none of its other fields — diffHint/brief/subtitle —
  // apply, since the branch below returns before any of them would be read), so its title is a
  // direct special-case rather than a mismatched-shape table entry. It names the MODE, not one of
  // its tabs: competition.js's own tab row (Quick Duel / Tournament / Roster / Standings) says
  // which screen you're on, and titling the whole mode after one tab stopped being true when
  // Phase 3 added tournaments.
  title.textContent = setup.mode === "competition" ? "🏆 Competition" : copy ? copy.title : "Configure the skirmish";
  mapSelectEl.appendChild(title);

  const ver = document.createElement("p");
  ver.className = "setup-version";
  ver.textContent = `SpaceCities v${APP_VERSION}`;
  mapSelectEl.appendChild(ver);

  // Mode toggle: skirmish, the open-world Odyssey, or a scripted scenario.
  // Picking one re-renders this screen so the setup rows + start action match.
  mapSelectEl.appendChild(optionGroup(setup.mode, MODES.map(m => ({ label: m.label, mult: m.key, note: m.note })),
    key => { setup.mode = key; renderMapSelect(); }));

  // Competition: a background AI-vs-AI simulation, not a playable game — no player economy, no
  // map size/resources/pop cap/match length/seed rows (renderSetupPanel's own rows below don't
  // apply, and its unconditional SCENARIO_COPY[mode].diffHint read would throw for a mode with no
  // entry there). competition.js owns the entire rest of the screen and renders directly into
  // mapSelectEl itself, the same way the cards flow below does — mirrors this function's own
  // `if (odyssey) { ... return; }` branch further down: an early return partway through, after the
  // shared title/version/mode-toggle chrome, for a mode whose layout genuinely diverges.
  if (setup.mode === "competition") { renderCompetition(); return; }

  // Offer to pick up the autosaved skirmish before starting a fresh one (skirmish only).
  if (setup.mode === "skirmish" && hasSave()) {
    const resume = document.createElement("button");
    resume.className = "btn resume-btn";
    resume.textContent = "▶ Continue — resume autosave";
    resume.title = "Resume your last skirmish from its browser autosave";
    resume.addEventListener("click", loadGame);
    mapSelectEl.appendChild(resume);
  }

  // T-034: the lobby's own entry point — host or join a real match over the network. Skirmish
  // only, the same scope FR-1/FR-2 describe ("a player may create a match..."); Odyssey/scenario/
  // competition stay exactly as they are today, untouched by any of this.
  if (setup.mode === "skirmish") {
    const multiplayer = document.createElement("button");
    multiplayer.className = "btn";
    multiplayer.textContent = "🌐 Multiplayer — host or join";
    multiplayer.title = "Play a match with another person over the network";
    multiplayer.addEventListener("click", async () => { const { renderLobbyScreen } = await import("./lobbyScreen.js"); renderLobbyScreen(); });
    mapSelectEl.appendChild(multiplayer);
  }

  // Scenarios and Odyssey get a brief blurb above the setup.
  if (copy) {
    const brief = document.createElement("p");
    brief.className = "setup-hint";
    brief.style.maxWidth = "560px";
    brief.textContent = copy.brief;
    mapSelectEl.appendChild(brief);
  }

  mapSelectEl.appendChild(renderSetupPanel(setup.mode));

  // Odyssey: a Resume button when a saved galaxy exists, then a compact world-card row — the
  // game's first real decision, previously withheld ("land on a random world" was the only
  // affordance). A default "Random" card preserves today's seed-derived draw exactly (same seed,
  // same world) for anyone who doesn't care to pick.
  if (odyssey) {
    if (hasOdysseySave()) {
      const resume = document.createElement("button");
      resume.className = "btn resume-btn";
      resume.textContent = "▶ Continue Odyssey — resume autosave";
      resume.title = "Resume your Odyssey from its browser autosave";
      resume.addEventListener("click", () => { sound.unlockAudio(); mapSelectEl.classList.add("hidden"); loadOdyssey(); });
      mapSelectEl.appendChild(resume);
    }

    const subtitle = document.createElement("h3");
    subtitle.className = "cards-heading";
    subtitle.textContent = "Choose your starting world — or land at random";
    mapSelectEl.appendChild(subtitle);

    // One click both picks the world (or Random) AND begins, mirroring the skirmish cards below
    // instead of adding a separate "confirm" step.
    const beginOn = startId => {
      sound.unlockAudio();   // a real user gesture, so it's safe to start the AudioContext here
      mapSelectEl.classList.add("hidden");
      setup.startWorld = startId;   // null -> createGalaxy draws its own seed-derived world, exactly as before
      startOdyssey();
    };

    const cards = document.createElement("div");
    cards.className = "cards";

    const randomCard = document.createElement("button");
    randomCard.className = "map-card map-card-compact";
    randomCard.innerHTML = `<span class="name">🎲 Random</span><span class="tag">Land on a random world</span>`;
    randomCard.addEventListener("click", () => beginOn(null));
    cards.appendChild(randomCard);

    ODYSSEY_START_CHOICES.forEach(id => {
      const planet = PLANETS.find(p => p.id === id);
      const mod = PLANET_MODIFIERS[id];
      const card = document.createElement("button");
      card.className = "map-card map-card-compact";
      // Reuses exactly the skirmish card's own data fields (name, deposits tag, archetype
      // doctrine, industry/tech) — just a smaller layout for the wider 11-world roster.
      card.innerHTML = `<span class="name">${planet.name}</span><span class="tag">${planet.tag}</span>`
        + `<span class="ai-note">${archetypeFor(id).name} neighbour</span>`
        + `<span class="sm-stats">⚙ ${planet.industry} · 🔬 ${planet.tech}</span>`
        + (mod ? `<span class="mod-note">${mod.label}</span>` : "");
      card.addEventListener("click", () => beginOn(id));
      cards.appendChild(card);
    });
    mapSelectEl.appendChild(cards);
    return;
  }

  const subtitle = document.createElement("h3");
  subtitle.className = "cards-heading";
  subtitle.textContent = isScenario ? copy.subtitle : "Then choose a battlefield";
  mapSelectEl.appendChild(subtitle);

  const cards = document.createElement("div");
  cards.className = "cards";
  MAP_CHOICES.forEach(id => {
    const planet = PLANETS.find(p => p.id === id);
    const mod = PLANET_MODIFIERS[id];
    const card = document.createElement("button");
    card.className = "map-card";
    // Skirmish cards advertise the opponent + the world modifier; scenario cards
    // just pick which world the convoy crosses.
    card.innerHTML = `<span class="name">${planet.name}</span><span class="tag">${planet.tag}</span><span class="desc">${planet.desc}</span>`
      + (isScenario ? "" : `<span class="ai-note">Opponent doctrine: ${archetypeFor(id).name}</span>`)
      + (mod ? `<span class="mod-note">${mod.label}</span>` : "");
    // Pick your side of an ASYMMETRIC matchup (Oort, Nimbus): a plain `<span>`, not a nested
    // `<button>` — a button can't validly contain another interactive control — styled
    // clickable and stopping its own click from bubbling up into the card's start-the-game
    // handler. A per-card LOCAL pick (not shared setup state): toggling one card's swap can
    // never leak onto a different card you click instead — only wired for skirmish, since the
    // scripted scenarios (setupEscort/Raider/Bounty) don't consume swapAsym.
    let swapped = false;
    if (mod && mod.asym && !isScenario) {
      const swapBtn = document.createElement("span");
      swapBtn.className = "map-card-swap";
      swapBtn.textContent = "⇄ Swap sides";
      swapBtn.addEventListener("click", e => {
        e.stopPropagation();
        swapped = !swapped;
        swapBtn.classList.toggle("active", swapped);
        swapBtn.textContent = swapped ? "⇄ Swapped — playing the other side" : "⇄ Swap sides";
      });
      card.appendChild(swapBtn);
    }
    card.addEventListener("click", () => {
      sound.unlockAudio();   // this click is a real user gesture, so it's safe to start the AudioContext here
      mapSelectEl.classList.add("hidden");
      setup.swapAsym = swapped;
      if (isScenario) SCENARIO_START[setup.mode](id); else startGame(id);
    });
    cards.appendChild(card);
  });
  mapSelectEl.appendChild(cards);
}
