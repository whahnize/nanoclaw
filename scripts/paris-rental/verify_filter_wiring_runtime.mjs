#!/usr/bin/env node
/**
 * Runtime test for Sub-AC 1.5.2 — exercises the JS wiring inside the rendered
 * paris-realestate.html against a hand-rolled minimal DOM + Leaflet shim.
 *
 * The structural test (verify_filter_wiring.py) proves the wiring patterns
 * exist. This runtime test proves they actually function: each of the 7 DOM
 * controls, when toggled, propagates through FilterState and re-runs
 * applyFilters with a different visible-marker subset.
 *
 * Strategy:
 *   1. Render the HTML via the Python renderer (small fixture).
 *   2. Extract the inline <script>…</script> body (excluding external src).
 *   3. Inject a minimal `document` mock that supports:
 *        - getElementById, querySelectorAll
 *        - addEventListener / dispatchEvent
 *        - .value / .checked / .classList / .innerHTML / setAttribute / etc.
 *      and a Leaflet shim (`L.map`, `L.tileLayer`, `L.marker`, `L.divIcon`,
 *      `L.markerClusterGroup`, `L.latLngBounds`).
 *   4. Run the script in a vm context.
 *   5. Toggle each of the 7 controls and assert FilterState contains the
 *      corresponding patch + the cluster's addLayers reflects the filter.
 *
 * Exits non-zero on any assertion failure.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const RENDERER = path.join(REPO_ROOT, 'container', 'skills', 'paris-rental-watch', 'render_map.py');

const FIXTURE = [
  // T2, meublé, 75014, bbs2, ≥2026-06, price=1200, area=35
  {
    namespaced_id: 'fz-bbs2:1', post_id: '1', source: 'francezone-bbs2',
    title: 'T2 14e arr', url: 'https://example.com/1', verdict: 'pass',
    lat: 48.83, lng: 2.32, location_text: '14e',
    price_eur: 1200, area_m2: 35, move_in: '2026-06-01',
    rooms: 'T2', meuble: 'meuble', zip_or_arr: '75014', term: 'long',
  },
  // T3, non, 75011, pap, flexible, price=1800, area=55
  {
    namespaced_id: 'pap:2', post_id: '2', source: 'pap',
    title: 'T3 11e arr', url: 'https://example.com/2', verdict: 'pass',
    lat: 48.85, lng: 2.37, location_text: '11e',
    price_eur: 1800, area_m2: 55, move_in: 'flexible',
    rooms: 'T3', meuble: 'non', zip_or_arr: '75011', term: 'short',
  },
  // T1, unknown, 92100, bbs3, missing date, price=900, area=22
  {
    namespaced_id: 'fz-bbs3:3', post_id: '3', source: 'francezone-bbs3',
    title: 'T1 92', url: 'https://example.com/3', verdict: 'ambiguous',
    lat: 48.88, lng: 2.24, location_text: 'Boulogne',
    price_eur: 900, area_m2: 22, move_in: null,
    rooms: 'T1', meuble: 'unknown', zip_or_arr: '92100', term: 'flex',
  },
  // T4+, meuble, 75001, bbs2, 2025-09 (PAST → blocked by move-in)
  {
    namespaced_id: 'fz-bbs2:4', post_id: '4', source: 'francezone-bbs2',
    title: 'T4+ 1e arr', url: 'https://example.com/4', verdict: 'pass',
    lat: 48.86, lng: 2.34, location_text: '1e',
    price_eur: 2400, area_m2: 80, move_in: '2025-09-01',
    rooms: 'T4+', meuble: 'meuble', zip_or_arr: '75001', term: 'long',
  },
];

// ---------------------------------------------------------------------------
// 1. Render HTML
// ---------------------------------------------------------------------------
const td = mkdtempSync(path.join(tmpdir(), 'parisfilter-rt-'));
const jsonl = path.join(td, 'l.jsonl');
const out = path.join(td, 'out.html');
const kml = path.join(td, 'out.kml');
writeFileSync(jsonl, FIXTURE.map(d => JSON.stringify(d)).join('\n') + '\n');
execFileSync('python3', [RENDERER, jsonl, out, kml, '2026-05-09T22:00:00+02:00'], {
  stdio: 'pipe',
});
const html = readFileSync(out, 'utf-8');

// ---------------------------------------------------------------------------
// 2. Extract every inline <script> body (skip external <script src=…> tags).
// ---------------------------------------------------------------------------
const scriptBlocks = [];
const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  const body = m[2] || '';
  if (/\bsrc=/.test(attrs)) continue;
  if (body.trim()) scriptBlocks.push(body);
}
if (scriptBlocks.length === 0) {
  console.error('FAIL: no inline <script> blocks found in rendered HTML');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Build minimal DOM + Leaflet shim.
// ---------------------------------------------------------------------------
// The DOM only has to support the operations the wiring code actually
// performs. We model elements as plain objects keyed by id/class lists, and
// give each one a .listeners table + dispatchEvent helper.

// DOMTokenList-like helper. Real classList supports add/remove/toggle/
// contains; sidebar code uses .toggle(name, force).
function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (...names) => names.forEach(n => set.add(n)),
    remove: (...names) => names.forEach(n => set.delete(n)),
    contains: (n) => set.has(n),
    toggle: (n, force) => {
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      return want;
    },
    [Symbol.iterator]: () => set[Symbol.iterator](),
    get size() { return set.size; },
    _set: set, // for tests
  };
}

class FakeNode {
  constructor(spec = {}) {
    this.id = spec.id || '';
    this.classList = makeClassList(spec.classes || []);
    this.attrs = { ...(spec.attrs || {}) };
    this.tag = spec.tag || 'div';
    this.value = spec.value != null ? String(spec.value) : '';
    this.checked = !!spec.checked;
    this.innerHTML = '';
    this.children = [];
    this.parent = null;
    this.listeners = {};
  }
  addEventListener(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
  }
  removeEventListener(evt, fn) {
    const a = this.listeners[evt];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i !== -1) a.splice(i, 1);
  }
  dispatchEvent(evt) {
    const t = typeof evt === 'string' ? evt : evt.type;
    for (const fn of (this.listeners[t] || []).slice()) fn(evt || { type: t });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  get className() { return [...this.classList].join(' '); }
  set className(s) {
    this.classList = makeClassList(String(s || '').split(/\s+/).filter(Boolean));
  }
}

// Build the catalog of nodes we care about.
function makeNodes() {
  const idIndex = new Map();
  const classIndex = new Map();
  const all = [];

  function add(spec) {
    const n = new FakeNode(spec);
    if (n.id) idIndex.set(n.id, n);
    for (const c of (spec.classes || [])) {
      if (!classIndex.has(c)) classIndex.set(c, []);
      classIndex.get(c).push(n);
    }
    all.push(n);
    return n;
  }

  // Range inputs (price/area)
  add({ id: 'filter-price-min', tag: 'input', attrs: { type: 'number' } });
  add({ id: 'filter-price-max', tag: 'input', attrs: { type: 'number' } });
  add({ id: 'filter-area-min',  tag: 'input', attrs: { type: 'number' } });
  add({ id: 'filter-area-max',  tag: 'input', attrs: { type: 'number' } });

  // Chip filters (rooms, meuble, sources, arr).
  // Real browser inputs expose the `value` attribute as the .value property —
  // the wiring's readChecked() reads `nodes[i].value`, so we must set both.
  function chips(cls, values) {
    return values.map(v => add({
      tag: 'input', classes: [cls], attrs: { type: 'checkbox', value: v }, value: v,
    }));
  }
  chips('filter-rooms', ['T1', 'T2', 'T3', 'T4+', 'unknown']);
  chips('filter-meuble', ['meuble', 'non', 'unknown']);
  chips('filter-term', ['long', 'short', 'flex', 'unknown']);
  chips('filter-sources', ['francezone-bbs2', 'francezone-bbs3', 'pap']);
  // 24 arr chips: 1..20 + 92,93,94 + unknown
  const arrVals = [];
  for (let i = 1; i <= 20; i++) arrVals.push(String(i));
  arrVals.push('92', '93', '94', 'unknown');
  chips('filter-arr', arrVals);

  // move-in single toggle
  add({
    id: 'filter-movein',
    tag: 'input',
    classes: ['filter-movein'],
    attrs: { type: 'checkbox' },
  });

  // Scaffolding
  add({ id: 'sidebar', tag: 'aside' });
  add({ id: 'sidebar-toggle', tag: 'button' });
  add({ id: 'sidebar-side-btn', tag: 'button' });
  add({ id: 'sidebar-content', tag: 'div' });
  add({ id: 'filter-count', tag: 'span' });
  add({ id: 'filter-reset', tag: 'button' });
  add({ id: 'map', tag: 'div' });

  return { idIndex, classIndex, all };
}

const { idIndex, classIndex, all } = makeNodes();

const fakeBody = new FakeNode({ tag: 'body' });

const document = {
  getElementById(id) { return idIndex.get(id) || null; },
  querySelector(sel) {
    const list = this.querySelectorAll(sel);
    return list[0] || null;
  },
  querySelectorAll(sel) {
    // Supports a small but sufficient subset:
    //   "input.cls"                  → all <input> elements with class
    //   "input.cls, input.cls2, ..." → union
    //   "input.cls:checked"          → filter by .checked
    //   "#sidebar-content input[type=\"checkbox\"]"  → all our chip+toggle
    //                                                 inputs (we don't model
    //                                                 sub-trees, so we just
    //                                                 return every input we
    //                                                 own that is type=checkbox)
    if (sel.includes('#sidebar-content')) {
      return all.filter(n => n.tag === 'input' && n.attrs.type === 'checkbox');
    }
    const results = new Set();
    for (let part of sel.split(',')) {
      part = part.trim();
      let checkedOnly = false;
      if (part.endsWith(':checked')) {
        checkedOnly = true;
        part = part.slice(0, -':checked'.length);
      }
      const m = /^input\.([\w-]+)$/.exec(part);
      if (!m) continue;
      const cls = m[1];
      const list = classIndex.get(cls) || [];
      for (const n of list) {
        if (checkedOnly && !n.checked) continue;
        results.add(n);
      }
    }
    return [...results];
  },
  body: fakeBody,
  // hashchange / openHash code reads location.hash; not exercised here.
  addEventListener() {},
  removeEventListener() {},
};

// Leaflet shim — tracks marker layers so we can assert the filter results.
const clusterAddLayersCalls = [];
const allMarkers = [];
let cluster;
const L = {
  map: () => {
    // Leaflet's map() returns an object whose chainable methods return self.
    // The wiring code does `const map = L.map(...).setView(...)`, so setView
    // must return the map.
    const m = {};
    m.setView = () => m;
    m.addLayer = () => m;
    m.fitBounds = () => m;
    m.invalidateSize = () => m;
    return m;
  },
  tileLayer: () => {
    const t = {};
    t.addTo = () => t;
    return t;
  },
  marker: (latlng) => {
    const m = {
      latlng,
      bindPopup() { return this; },
      getLatLng() { return latlng; },
      openPopup() {},
    };
    allMarkers.push(m);
    return m;
  },
  divIcon: () => ({}),
  markerClusterGroup: () => {
    cluster = {
      _layers: [],
      clearLayers() { this._layers = []; },
      addLayers(arr) { this._layers = this._layers.concat(arr); clusterAddLayersCalls.push(arr.length); },
      addLayer() {},
      zoomToShowLayer(_, cb) { cb && cb(); },
    };
    return cluster;
  },
  latLngBounds: (pts) => ({ pad: () => pts }),
};

// requestAnimationFrame stub — call synchronously so 'input' debounce flushes.
function requestAnimationFrame(fn) { fn(); return 0; }

// localStorage stub for the sidebar-toggle code.
const localStorage = {
  _: new Map(),
  getItem(k) { return this._.has(k) ? this._.get(k) : null; },
  setItem(k, v) { this._.set(k, String(v)); },
};

const window = { innerWidth: 1024, addEventListener: () => {} };
const location = { hash: '' };

// ---------------------------------------------------------------------------
// 4. Run the script in a vm sandbox.
// ---------------------------------------------------------------------------
const sandbox = {
  document, window, location, L, localStorage, requestAnimationFrame,
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// Top-level `const FilterState = …` in vm.runInContext creates a lexical
// binding scoped to the script, not on the sandbox global. Append an
// expose-to-global epilogue so the test can interrogate it.
const epilogue = `
;try { globalThis.FilterState = FilterState; } catch(e){}
;try { globalThis.applyFilters = applyFilters; } catch(e){}
;try { globalThis.passesFilter = passesFilter; } catch(e){}
;try { globalThis.arrBucket = arrBucket; } catch(e){}
`;
const wrapped = scriptBlocks.join(';\n;') + epilogue;
try {
  vm.runInContext(wrapped, sandbox, { filename: 'paris-realestate.inline.js' });
} catch (e) {
  console.error('FAIL: inline script threw at load time:', e);
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// FilterState lives in the sandbox global thanks to `const` at top level
// being hoisted into globalThis under vm. Grab references for assertions.
const FilterState = sandbox.FilterState;
if (!FilterState || typeof FilterState.get !== 'function') {
  console.error('FAIL: FilterState not exposed on sandbox after load');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// Initial paint should have populated the cluster with all 4 listings.
const initialCount = clusterAddLayersCalls.at(-1) ?? null;

// ---------------------------------------------------------------------------
// 5. Per-axis assertions.
// ---------------------------------------------------------------------------
let failures = 0;
function assert(label, cond, detail) {
  const status = cond ? 'OK' : 'FAIL';
  console.log(`[${status}] ${label}: ${detail}`);
  if (!cond) failures++;
}

assert('initial paint', initialCount === 4, `applyFilters added ${initialCount}/4 markers`);

// Helper: push a value into a number input + dispatch 'input' (rAF flushes
// synchronously in our shim) + assert FilterState reflects it.
function setRange(id, val) {
  const el = idIndex.get(id);
  el.value = val == null ? '' : String(val);
  el.dispatchEvent({ type: 'input' });
}
function toggleChip(cls, value, checked = true) {
  const list = classIndex.get(cls) || [];
  const el = list.find(n => n.attrs.value === value);
  if (!el) throw new Error(`no chip ${cls}=${value}`);
  el.checked = checked;
  el.dispatchEvent({ type: 'change' });
}
function setMoveIn(checked) {
  const el = idIndex.get('filter-movein');
  el.checked = checked;
  el.dispatchEvent({ type: 'change' });
}
function lastVisible() { return clusterAddLayersCalls.at(-1); }
function reset() {
  // Clear the DOM directly (mirroring what #filter-reset does), then
  // re-sync. We don't click the reset button because dispatchEvent on a
  // <button> doesn't model click→handler in our minimal mock; the wiring
  // installs a 'click' listener so we trigger that directly.
  idIndex.get('filter-reset').dispatchEvent({ type: 'click' });
}

// === axis 1: price ===
setRange('filter-price-min', 1000);
setRange('filter-price-max', 1500);
assert('price→state', FilterState.get().priceMin === 1000 && FilterState.get().priceMax === 1500,
  `priceMin/Max=${FilterState.get().priceMin}/${FilterState.get().priceMax}`);
assert('price filters cluster', lastVisible() === 1,
  `expected 1 (only T2@1200€), got ${lastVisible()}`);
reset();
assert('reset clears price', FilterState.get().priceMin === null && FilterState.get().priceMax === null,
  `priceMin/Max=${FilterState.get().priceMin}/${FilterState.get().priceMax}`);
assert('reset re-shows all (price)', lastVisible() === 4, `got ${lastVisible()}`);

// === axis 2: area ===
setRange('filter-area-min', 30);
setRange('filter-area-max', 60);
assert('area→state', FilterState.get().areaMin === 30 && FilterState.get().areaMax === 60,
  `areaMin/Max=${FilterState.get().areaMin}/${FilterState.get().areaMax}`);
assert('area filters cluster', lastVisible() === 2,
  `expected 2 (T2@35, T3@55), got ${lastVisible()}`);
reset();

// === axis 3: rooms ===
toggleChip('filter-rooms', 'T2');
toggleChip('filter-rooms', 'T3');
assert('rooms→state', FilterState.get().roomsSelected.length === 2 &&
  FilterState.get().roomsSelected.includes('T2') &&
  FilterState.get().roomsSelected.includes('T3'),
  `roomsSelected=${JSON.stringify(FilterState.get().roomsSelected)}`);
assert('rooms filters cluster', lastVisible() === 2, `expected 2, got ${lastVisible()}`);
reset();

// === axis 4: meuble ===
toggleChip('filter-meuble', 'meuble');
assert('meuble→state', FilterState.get().meubleSelected.length === 1 &&
  FilterState.get().meubleSelected[0] === 'meuble',
  `meubleSelected=${JSON.stringify(FilterState.get().meubleSelected)}`);
assert('meuble filters cluster', lastVisible() === 2,
  `expected 2 (T2@meuble + T4+@meuble), got ${lastVisible()}`);
reset();

// === axis 5: move-in (≥2026-06 or missing) ===
setMoveIn(true);
assert('move-in→state', FilterState.get().moveInAfter202606 === true,
  `moveInAfter202606=${FilterState.get().moveInAfter202606}`);
// Pass: 2026-06-01 (axis 1), flexible (axis 2), null (axis 3). Reject: 2025-09 (axis 4).
assert('move-in filters cluster', lastVisible() === 3, `expected 3, got ${lastVisible()}`);
reset();

// === axis: term (장기/단기) ===
toggleChip('filter-term', 'short');
assert('term→state', FilterState.get().termSelected.length === 1 &&
  FilterState.get().termSelected[0] === 'short',
  `termSelected=${JSON.stringify(FilterState.get().termSelected)}`);
// Only fixture #2 (pap T3) is term=short.
assert('term filters cluster (short)', lastVisible() === 1,
  `expected 1 (only short), got ${lastVisible()}`);
toggleChip('filter-term', 'long');
// short + long → #1, #2, #4 (term long/short/long); #3 is flex → excluded.
assert('term filters cluster (short+long)', lastVisible() === 3,
  `expected 3 (short+long), got ${lastVisible()}`);
reset();

// === axis 6: sources ===
toggleChip('filter-sources', 'pap');
assert('sources→state', FilterState.get().sourcesSelected.includes('pap'),
  `sourcesSelected=${JSON.stringify(FilterState.get().sourcesSelected)}`);
assert('sources filters cluster', lastVisible() === 1,
  `expected 1 (only PAP T3), got ${lastVisible()}`);
reset();

// === axis 7: arr ===
toggleChip('filter-arr', '14');
toggleChip('filter-arr', '92');
assert('arr→state', FilterState.get().arrSelected.includes('14') &&
  FilterState.get().arrSelected.includes('92'),
  `arrSelected=${JSON.stringify(FilterState.get().arrSelected)}`);
// Pass: 75014 (axis 1) + 92100 (axis 3). Reject: 75011, 75001.
assert('arr filters cluster', lastVisible() === 2, `expected 2, got ${lastVisible()}`);
reset();

// === combined: rooms=T2 + meuble=meuble + price 1000-1500 ===
setRange('filter-price-min', 1000);
setRange('filter-price-max', 1500);
toggleChip('filter-rooms', 'T2');
toggleChip('filter-meuble', 'meuble');
assert('combined filter cluster', lastVisible() === 1,
  `expected 1 (only T2 75014 1200€ meublé), got ${lastVisible()}`);
reset();

// === metroLinesSelected exists in state but has no DOM yet ===
assert('metroLinesSelected slot', Array.isArray(FilterState.get().metroLinesSelected) &&
  FilterState.get().metroLinesSelected.length === 0,
  `metroLinesSelected=${JSON.stringify(FilterState.get().metroLinesSelected)}`);

// ---------------------------------------------------------------------------
// 6. Cleanup + summary
// ---------------------------------------------------------------------------
rmSync(td, { recursive: true, force: true });

console.log();
if (failures) {
  console.error(`verify_filter_wiring_runtime: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('verify_filter_wiring_runtime: every axis routes DOM → FilterState → applyFilters ✓');
