/* ============================================================
   The shared DOM double for the browser-layer tests.

   Eight test files each grew their own `class FakeElement extends EventTarget`
   — hud, hudSelection, observer, overlays, saveload, starmap, techChart,
   update — plus four copies of the same no-op-Proxy `fakeCtx()` and eight
   copies of a byte-identical `fakeDocument()`. They were ~90% the same code,
   and the 10% that differed was not a considered difference: it was whichever
   subset of the DOM the file that copied it happened to need that week. So
   overlays' copy grew real `.remove()` parent tracking and hudSelection's did
   not; hud's grew a real `querySelector` that walks the tree and update's kept
   the always-null stub; observer's `getBoundingClientRect` returned a real
   800x600 box and saveload's returned zeros. A test written against a weak
   copy silently asserts less than the same test written against a strong one,
   and nothing tells you which copy you landed on.

   This is the union, with the strongest implementation of each member — real
   child arrays, real per-instance class state, real parent tracking so
   `.remove()` splices, and a real (if shallow) `querySelector` — so every file
   starts from the best version rather than the weakest.

   TWO THINGS ARE DELIBERATELY CONFIGURABLE, because making them uniform would
   change what the code under test actually does:

   • `context` — what `getContext()` hands back. dom.js calls
     `.getContext("2d")` on the canvas handles at module scope no matter what
     the test is about, so it always has to succeed. Returning null (the
     default) leaves modules that guard `if (!ctx) return` inert; returning
     `fakeCtx()` lets them run all the way through. Files whose subject
     actually draws (render.js's spriteIcon reads `canvas.toDataURL()` back,
     and its own catch fires a console.error on EVERY icon button of EVERY
     render if either half fails) pass `{ context: fakeCtx }`.
   • `clientWidth` / `clientHeight` — the viewport `getBoundingClientRect`
     reports. Camera and pointer-mapping code divides by these, so zeros and
     800x600 are genuinely different test fixtures, not a detail.

   USAGE — dom.js resolves every element handle exactly ONCE, at import time,
   via `doc.getElementById(id)`, so the document has to exist BEFORE anything
   that transitively imports dom.js is first imported. Under `node --test`'s
   native ESM loader that means installFakeDom() at the top of the file and
   `await import(...)` for the modules under test, never a static import:

       import { installFakeDom, fakeCtx } from "./_dom.js";
       installFakeDom({ context: fakeCtx });
       const { renderSelectionPanel } = await import("../hudSelection.js");
   ============================================================ */

"use strict";

// Module-level rather than threaded through every constructor: `node --test` gives each test
// FILE its own process, so there is exactly one document per process and installFakeDom() sets
// this once, before the first dynamic import.
const DEFAULTS = { context: () => null, clientWidth: 800, clientHeight: 600 };
let config = { ...DEFAULTS };

// Any method call is a silent no-op; any property read/write round-trips through a plain backing
// object. That tolerates whatever drawUnitShape/drawBuildingShape happen to call (scale/translate/
// fillStyle/strokeStyle/gradients/…) without hand-enumerating the 2D canvas API, and stays robust
// to unrelated changes in those drawing functions. Tests that need to ASSERT on the draw calls
// want a recording proxy instead — see the golden-trace harness in test/render.test.js.
export function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}

export class FakeElement extends EventTarget {
  constructor(tag = "div") {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.clientWidth = config.clientWidth;
    this.clientHeight = config.clientHeight;
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      toggle: (c, f) => {
        const on = f === undefined ? !this._classes.has(c) : f;
        if (on) this._classes.add(c); else this._classes.delete(c);
        return on;   // real classList.toggle returns the resulting state
      },
      contains: c => this._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  // Parent tracking is what makes `.remove()` real: showGalaxyToast's eviction (overlays.js) and
  // showBanner's "replace any prior banner" (update.js) both call .remove() on a CHILD element,
  // which in the real DOM splices itself out of its own parent.
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => { c._parent = this; this.children.push(c); }); }
  prepend(c) { c._parent = this; this.children.unshift(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i !== -1) { this.children.splice(i, 1); c._parent = null; }
    return c;
  }
  remove() {
    if (!this._parent) return;
    const i = this._parent.children.indexOf(this);
    if (i !== -1) this._parent.children.splice(i, 1);
    this._parent = null;
  }
  // children are pushed in append order, so index 0 IS the oldest — what showGalaxyToast's
  // all-clickable eviction branch (`stack.firstElementChild`) needs.
  get firstElementChild() { return this.children[0] || null; }
  closest(selector) {
    const cls = selector.startsWith(".") ? selector.slice(1) : null;
    for (let n = this; n; n = n._parent) if (cls && n._classes?.has(cls)) return n;
    return null;
  }

  // A real (if shallow) innerHTML round-trip: `= ""` clears the children the way the real thing
  // does — that is the only value most rebuild paths ever assign — and any other string is
  // readable back as the string it was, so a panel built from a raw template (showGameOver's
  // score breakdown, showScenarioEnd) is inspectable rather than always reading empty. No real
  // HTML PARSING: nothing here needs the assigned string to become child nodes.
  set innerHTML(v) { this._html = v; if (v === "") this.children = []; }
  get innerHTML() { return this._html ?? ""; }

  // A minimal REAL selector. Every call site in the browser layer queries a single class name
  // (".market-row", ".queue-label", ".recycle-progress", …) — never a combinator or an attribute
  // selector — so a depth-first walk matching one class per node is enough. The always-null stub
  // some copies used is tolerated by every live-patch call site (`if (row) …` / `rows[i] && …`),
  // which is exactly the problem: a test written against it can never tell "the code patched
  // nothing" apart from "the code patched a node I could not find".
  _queryAll(selector) {
    const cls = selector.startsWith(".") ? selector.slice(1) : null;
    const out = [];
    const walk = kids => { for (const c of kids) { if (cls && c._classes?.has(cls)) out.push(c); if (c.children) walk(c.children); } };
    walk(this.children);
    return out;
  }
  querySelector(selector) { return this._queryAll(selector)[0] || null; }
  querySelectorAll(selector) { return this._queryAll(selector); }

  // Attributes are kept as a real map rather than no-ops: openLandingPicker (boot.js) sets
  // type/aria attributes on the controls it builds, and a no-op setter makes "did it set the
  // attribute?" permanently unanswerable.
  setAttribute(name, value) { (this._attrs ??= {})[name] = String(value); }
  getAttribute(name) { return this._attrs?.[name] ?? null; }
  removeAttribute(name) { if (this._attrs) delete this._attrs[name]; }
  focus() { this._focused = true; }
  blur() { this._focused = false; }

  // A real <select>'s `.value` is its selected option's value, and with nothing selected that is
  // the FIRST option — which is what every "the user didn't touch this dial" path reads. Without
  // it, `Number(sizeSelect.value)` is NaN and a test asserting on a POST body would be asserting
  // against a shape the browser never produces. An explicit assignment still wins, exactly as it
  // does in the real DOM.
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === "select") return this.children[0]?.value;
    return undefined;
  }
  set value(v) { this._value = v; }
  select() { this._selected = true; }

  getContext() { return config.context(); }
  toDataURL() { return "data:image/fake,"; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  // Mirrors real HTMLElement#click(); hudSelection.js's own prodButton calls it for hotkey replay.
  click() { this.dispatchEvent(new Event("click")); }
}

// Real per-id identity. dom.js resolves each handle exactly ONCE at import time and every later
// doc.getElementById(sameId) must keep returning that SAME object, or dom.js's exported handles
// (panelEl, galaxyToastEl, starmapEl, …) silently diverge from what the code under test is
// actually appending to — and the test then inspects an empty tree that nothing ever wrote.
export function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    // A text node is not an element, but it is appended like one (lobbyScreen.js's own
    // "Allow spectators" label), so the cheapest faithful stand-in is a node that carries its
    // text and has an empty child list like everything else the walkers here traverse.
    createTextNode(text) { const n = new FakeElement("#text"); n.textContent = text; return n; },
    body,
  };
}

/**
 * Install a fake `document` on globalThis and return it. Call BEFORE the first
 * `await import()` of anything that reaches dom.js.
 * @param {{context?: () => any, clientWidth?: number, clientHeight?: number}} [opts]
 */
export function installFakeDom(opts = {}) {
  config = { ...DEFAULTS, ...opts };
  globalThis.document = fakeDocument();
  return globalThis.document;
}
