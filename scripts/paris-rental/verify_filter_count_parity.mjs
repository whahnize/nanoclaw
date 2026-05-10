#!/usr/bin/env node
/**
 * AC 2 regression test — "any filter combination ⇒ visible pin count = data
 * matching count, exactly."
 *
 * The Seed contract for the Paris rental Leaflet sidebar requires that when
 * the user toggles arbitrary filters, the count shown in the sidebar (#filter-count),
 * the number of markers actually attached to the MarkerCluster, and the number
 * of fixture rows that satisfy the predicate must all be IDENTICAL — no
 * off-by-one, no AND/OR confusion, no silent fallthroughs on null fields.
 *
 * This script proves that property end-to-end against the rendered HTML:
 *
 *   1. Build a 30-row fixture covering every chip value (every rooms class,
 *      every meublé state, every source, multiple arrondissements, the
 *      unknown bucket on every axis, missing price/area/move_in fields, edge
 *      values exactly on a numeric bound, etc.).
 *   2. Render via the canonical container/skills/paris-rental-watch/render_map.py.
 *   3. Load the inline <script> in a vm sandbox with the same minimal DOM +
 *      Leaflet shim used by verify_filter_wiring_runtime.mjs (so we observe
 *      the real applyFilters() output).
 *   4. Re-implement the filter predicate in this file (`referenceMatch`) — an
 *      INDEPENDENT second source of truth — so that "expected" is computed
 *      without relying on the code under test.
 *   5. Drive ~25 filter scenarios (single axis, multi-axis, every boundary
 *      flavor, the empty filter, several zero-result combos) by replacing
 *      FilterState in one shot, then assert THREE numbers match exactly:
 *        a) cluster._layers.length          (markers actually displayed)
 *        b) #filter-count "<n>" text        (sidebar count UI)
 *        c) referenceMatch().length         (independent expected count)
 *
 * Exits non-zero on any mismatch, with a verbose diff so the failing scenario
 * is immediately reproducible. Run from the repo root:
 *
 *     node scripts/paris-rental/verify_filter_count_parity.mjs
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

// ---------------------------------------------------------------------------
// 1. Fixture — 30 rows engineered to exercise every filter axis & edge case.
//
// Conventions:
//   - rooms     ∈ T1 / T2 / T3 / T4+ / unknown / null  (null → 'unknown' bucket)
//   - meuble    ∈ meuble / non / unknown / null
//   - source    ∈ francezone-bbs2 / francezone-bbs3 / pap
//   - zip_or_arr — '750NN' Paris codes, '92xxx'/'93xxx'/'94xxx' suburbs, or
//     '78xxx' (out-of-area → 'unknown' arr bucket), or null
//   - price/area — null = "missing field"; null on either bound side is
//     defined to PASS the range gate per the renderer's inRange().
//   - move_in   — ISO-ish string, "flexible", or null
// ---------------------------------------------------------------------------
const FIXTURE = [
  // T1 cluster -----------------------------------------------------------------
  { post_id: 'a01', source: 'francezone-bbs2', rooms: 'T1', meuble: 'meuble',  price_eur: 700,  area_m2: 18, move_in: '2026-07-01', zip_or_arr: '75003' },
  { post_id: 'a02', source: 'francezone-bbs3', rooms: 'T1', meuble: 'non',     price_eur: 850,  area_m2: 22, move_in: '2026-06-01', zip_or_arr: '75011' },
  { post_id: 'a03', source: 'pap',             rooms: 'T1', meuble: 'unknown', price_eur: 950,  area_m2: 25, move_in: 'flexible',   zip_or_arr: '92100' },
  // T2 cluster -----------------------------------------------------------------
  { post_id: 'b01', source: 'francezone-bbs2', rooms: 'T2', meuble: 'meuble',  price_eur: 1200, area_m2: 35, move_in: '2026-06-15', zip_or_arr: '75014' },
  { post_id: 'b02', source: 'francezone-bbs2', rooms: 'T2', meuble: 'non',     price_eur: 1100, area_m2: 33, move_in: '2026-08-01', zip_or_arr: '75015' },
  { post_id: 'b03', source: 'francezone-bbs3', rooms: 'T2', meuble: 'meuble',  price_eur: 1400, area_m2: 40, move_in: '2025-12-01', zip_or_arr: '75009' },
  { post_id: 'b04', source: 'pap',             rooms: 'T2', meuble: 'non',     price_eur: 1500, area_m2: 38, move_in: '2026-09-01', zip_or_arr: '93200' },
  // T3 cluster -----------------------------------------------------------------
  { post_id: 'c01', source: 'francezone-bbs3', rooms: 'T3', meuble: 'meuble',  price_eur: 1800, area_m2: 55, move_in: '2026-06-01', zip_or_arr: '75017' },
  { post_id: 'c02', source: 'pap',             rooms: 'T3', meuble: 'non',     price_eur: 1900, area_m2: 60, move_in: '2026-10-01', zip_or_arr: '94200' },
  { post_id: 'c03', source: 'francezone-bbs2', rooms: 'T3', meuble: 'meuble',  price_eur: 2100, area_m2: 65, move_in: 'flexible',   zip_or_arr: '75007' },
  // T4+ cluster ----------------------------------------------------------------
  { post_id: 'd01', source: 'pap',             rooms: 'T4+', meuble: 'meuble', price_eur: 2600, area_m2: 80, move_in: '2026-06-01', zip_or_arr: '75016' },
  { post_id: 'd02', source: 'francezone-bbs3', rooms: 'T4+', meuble: 'non',    price_eur: 2900, area_m2: 95, move_in: '2025-09-01', zip_or_arr: '92200' },
  // unknown rooms / unknown meuble (chip "미기재") ------------------------------
  { post_id: 'e01', source: 'francezone-bbs2', rooms: 'unknown', meuble: 'unknown', price_eur: 1300, area_m2: 40, move_in: null,             zip_or_arr: '75020' },
  { post_id: 'e02', source: 'francezone-bbs3', rooms: null,      meuble: null,      price_eur: 1000, area_m2: 28, move_in: '2026-06-01',     zip_or_arr: '75002' },
  // missing price / area (must PASS any range gate that includes them) ---------
  { post_id: 'f01', source: 'pap',             rooms: 'T2', meuble: 'meuble',  price_eur: null, area_m2: 30,   move_in: '2026-07-01', zip_or_arr: '75019' },
  { post_id: 'f02', source: 'francezone-bbs2', rooms: 'T3', meuble: 'non',     price_eur: 1700, area_m2: null, move_in: '2026-06-01', zip_or_arr: '75008' },
  { post_id: 'f03', source: 'francezone-bbs3', rooms: 'T1', meuble: 'meuble',  price_eur: null, area_m2: null, move_in: 'flexible',   zip_or_arr: '75004' },
  // suburbs (92/93/94) ---------------------------------------------------------
  { post_id: 'g01', source: 'pap',             rooms: 'T2', meuble: 'non',     price_eur: 1050, area_m2: 32, move_in: '2026-06-01', zip_or_arr: '92100' },
  { post_id: 'g02', source: 'francezone-bbs3', rooms: 'T3', meuble: 'meuble',  price_eur: 1450, area_m2: 50, move_in: '2026-07-01', zip_or_arr: '93100' },
  { post_id: 'g03', source: 'francezone-bbs2', rooms: 'T1', meuble: 'non',     price_eur: 800,  area_m2: 25, move_in: '2026-06-01', zip_or_arr: '94300' },
  // out-of-area / null zip → arrBucket = 'unknown' -----------------------------
  { post_id: 'h01', source: 'pap',             rooms: 'T2', meuble: 'meuble',  price_eur: 1000, area_m2: 30, move_in: 'flexible',   zip_or_arr: '78100' },
  { post_id: 'h02', source: 'francezone-bbs3', rooms: 'T2', meuble: 'non',     price_eur: 1150, area_m2: 34, move_in: null,         zip_or_arr: null     },
  // boundary cases — values land EXACTLY on a slider bound ---------------------
  { post_id: 'i01', source: 'francezone-bbs2', rooms: 'T2', meuble: 'meuble',  price_eur: 1000, area_m2: 30, move_in: '2026-06-01', zip_or_arr: '75012' },
  { post_id: 'i02', source: 'francezone-bbs2', rooms: 'T2', meuble: 'meuble',  price_eur: 1500, area_m2: 50, move_in: '2026-06-01', zip_or_arr: '75013' },
  // move-in past dates / unparseable ------------------------------------------
  { post_id: 'j01', source: 'pap',             rooms: 'T3', meuble: 'meuble',  price_eur: 1850, area_m2: 58, move_in: '2025-04-01',  zip_or_arr: '75005' },
  { post_id: 'j02', source: 'francezone-bbs2', rooms: 'T2', meuble: 'non',     price_eur: 1250, area_m2: 36, move_in: 'à discuter', zip_or_arr: '75006' },
  { post_id: 'j03', source: 'francezone-bbs3', rooms: 'T1', meuble: 'unknown', price_eur: 750,  area_m2: 20, move_in: '2027-01-01', zip_or_arr: '75010' },
  // misc filler so total = 30 -------------------------------------------------
  { post_id: 'k01', source: 'pap',             rooms: 'T1', meuble: 'meuble',  price_eur: 920,  area_m2: 24, move_in: '2026-06-30', zip_or_arr: '75001' },
  { post_id: 'k02', source: 'francezone-bbs2', rooms: 'T3', meuble: 'meuble',  price_eur: 2050, area_m2: 62, move_in: '2026-08-01', zip_or_arr: '75018' },
  { post_id: 'k03', source: 'francezone-bbs3', rooms: 'T4+', meuble: 'unknown', price_eur: 2700, area_m2: 90, move_in: 'flexible',  zip_or_arr: '92500' },
];

// Common HTML-required fields so render_map.py accepts the row.
let LAT_BASE = 48.83, LNG_BASE = 2.30;
for (let i = 0; i < FIXTURE.length; i++) {
  const d = FIXTURE[i];
  d.namespaced_id = (d.source === 'pap' ? 'pap' : (d.source === 'francezone-bbs3' ? 'fz-bbs3' : 'fz-bbs2')) + ':' + d.post_id;
  d.title = d.post_id + ' ' + (d.rooms || 'unknown') + ' ' + (d.zip_or_arr || 'noaddr');
  d.url = 'https://example.com/' + d.post_id;
  d.verdict = (i % 5 === 0) ? 'ambiguous' : 'pass';
  d.lat = LAT_BASE + (i * 0.001);
  d.lng = LNG_BASE + (i * 0.001);
  d.location_text = d.zip_or_arr || 'unknown';
}

// ---------------------------------------------------------------------------
// 2. Render via the canonical Python renderer.
// ---------------------------------------------------------------------------
const td = mkdtempSync(path.join(tmpdir(), 'parisfilter-cnt-'));
const jsonl = path.join(td, 'l.jsonl');
const out = path.join(td, 'out.html');
const kml = path.join(td, 'out.kml');
writeFileSync(jsonl, FIXTURE.map(d => JSON.stringify(d)).join('\n') + '\n');
execFileSync('python3', [RENDERER, jsonl, out, kml, '2026-05-09T22:00:00+02:00'], { stdio: 'pipe' });
const html = readFileSync(out, 'utf-8');

// Extract every inline <script> body — same approach as the wiring runtime test.
const scriptBlocks = [];
{
  const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc=/.test(attrs)) continue;
    if (body.trim()) scriptBlocks.push(body);
  }
}
if (scriptBlocks.length === 0) {
  console.error('FAIL: no inline <script> blocks in rendered HTML');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Minimal DOM + Leaflet shim.  Same shape as verify_filter_wiring_runtime.mjs;
//    duplicated rather than imported so this test stays self-contained.
// ---------------------------------------------------------------------------
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
    this.listeners = {};
  }
  addEventListener(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  removeEventListener(evt, fn) {
    const a = this.listeners[evt]; if (!a) return;
    const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1);
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
  add({ id: 'filter-price-min', tag: 'input', attrs: { type: 'number' } });
  add({ id: 'filter-price-max', tag: 'input', attrs: { type: 'number' } });
  add({ id: 'filter-area-min',  tag: 'input', attrs: { type: 'number' } });
  add({ id: 'filter-area-max',  tag: 'input', attrs: { type: 'number' } });
  function chips(cls, values) {
    return values.map(v => add({
      tag: 'input', classes: [cls], attrs: { type: 'checkbox', value: v }, value: v,
    }));
  }
  chips('filter-rooms',   ['T1', 'T2', 'T3', 'T4+', 'unknown']);
  chips('filter-meuble',  ['meuble', 'non', 'unknown']);
  chips('filter-sources', ['francezone-bbs2', 'francezone-bbs3', 'pap']);
  const arrVals = [];
  for (let i = 1; i <= 20; i++) arrVals.push(String(i));
  arrVals.push('92', '93', '94', 'unknown');
  chips('filter-arr', arrVals);
  add({
    id: 'filter-movein', tag: 'input',
    classes: ['filter-movein'], attrs: { type: 'checkbox' },
  });
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
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  querySelectorAll(sel) {
    if (sel.includes('#sidebar-content')) {
      return all.filter(n => n.tag === 'input' && n.attrs.type === 'checkbox');
    }
    const results = new Set();
    for (let part of sel.split(',')) {
      part = part.trim();
      let checkedOnly = false;
      if (part.endsWith(':checked')) { checkedOnly = true; part = part.slice(0, -':checked'.length); }
      const m = /^input\.([\w-]+)$/.exec(part);
      if (!m) continue;
      const cls = m[1];
      for (const n of (classIndex.get(cls) || [])) {
        if (checkedOnly && !n.checked) continue;
        results.add(n);
      }
    }
    return [...results];
  },
  body: fakeBody,
  addEventListener() {}, removeEventListener() {},
};

// Leaflet shim — track marker layers + per-marker latlngs so we can compare
// the EXACT set of markers shown vs. expected (not just the count).
const allMarkers = [];
let cluster;
const L = {
  map: () => {
    const m = {};
    m.setView = () => m; m.addLayer = () => m;
    m.fitBounds = () => m; m.invalidateSize = () => m;
    return m;
  },
  tileLayer: () => ({ addTo() { return this; } }),
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
      addLayers(arr) { this._layers = this._layers.concat(arr); },
      addLayer() {},
      zoomToShowLayer(_, cb) { cb && cb(); },
    };
    return cluster;
  },
  latLngBounds: (pts) => ({ pad: () => pts }),
};

function requestAnimationFrame(fn) { fn(); return 0; }
const localStorage = {
  _: new Map(),
  getItem(k) { return this._.has(k) ? this._.get(k) : null; },
  setItem(k, v) { this._.set(k, String(v)); },
};
const window = { innerWidth: 1024, addEventListener: () => {} };
const location = { hash: '' };

const sandbox = {
  document, window, location, L, localStorage, requestAnimationFrame,
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  console: { log() {}, warn() {}, error() {} }, // silence inline noise
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

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

const FilterState = sandbox.FilterState;
if (!FilterState || typeof FilterState.get !== 'function') {
  console.error('FAIL: FilterState not exposed');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Reference filter — INDEPENDENT second source of truth.
//
// This deliberately mirrors render_map.py's documented semantics WITHOUT
// importing them, so a regression in the renderer's predicate cannot also
// silently corrupt the expected count. The semantics (per the inline JS docs
// in render_map.py):
//
//   - Range gate (price/area):
//       null value → PASS (don't punish missing fields)
//       min!=null && v < min → REJECT
//       max!=null && v > max → REJECT
//       (bounds inclusive on both sides)
//   - Set gate (rooms/meuble/source/arr):
//       empty selection → PASS (no filter)
//       null/'' value → bucketed as 'unknown' before lookup
//       in selection → PASS, else REJECT
//   - move_in gate (only when toggle on):
//       null/empty/'flexible'/unparseable → PASS
//       parseable YYYY-MM ≥ 2026-06 → PASS, else REJECT
//   - arr bucket (mirror of arrBucket in renderer):
//       /^75(\d{3})$/ → '1'..'20' (last two digits, no leading zero), else unknown
//       /^9[234]\d{3}$/ → '92' / '93' / '94'
//       else → 'unknown'
//
// This must stay byte-for-byte aligned with the documented contract — if you
// change render_map.py's filter semantics, update this function too.
// ---------------------------------------------------------------------------
function refArrBucket(zip) {
  if (zip == null) return 'unknown';
  const s = String(zip).trim();
  if (s === '') return 'unknown';
  const m75 = /^75(\d{3})$/.exec(s);
  if (m75) {
    const n = parseInt(m75[1], 10);
    if (n >= 1 && n <= 20) return String(n);
    return 'unknown';
  }
  if (/^9[234]\d{3}$/.test(s)) return s.slice(0, 2);
  return 'unknown';
}
function refRange(v, min, max) {
  if (v == null) return true;
  if (min != null && v < min) return false;
  if (max != null && v > max) return false;
  return true;
}
function refSet(v, selected) {
  if (!selected || selected.length === 0) return true;
  const bucket = (v == null || v === '') ? 'unknown' : v;
  return selected.indexOf(bucket) !== -1;
}
function refMoveInOk(m) {
  if (m == null) return true;
  const s = String(m).trim();
  if (s === '' || s.toLowerCase() === 'flexible') return true;
  const match = /^(\d{4})-(\d{1,2})/.exec(s);
  if (!match) return true;
  const y = parseInt(match[1], 10), mm = parseInt(match[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mm)) return true;
  if (y > 2026) return true;
  if (y === 2026 && mm >= 6) return true;
  return false;
}
function referenceMatch(state) {
  return FIXTURE.filter(d => {
    if (!refRange(d.price_eur, state.priceMin, state.priceMax)) return false;
    if (!refRange(d.area_m2,   state.areaMin,  state.areaMax))  return false;
    if (!refSet(d.rooms,  state.roomsSelected))  return false;
    if (!refSet(d.meuble, state.meubleSelected)) return false;
    if (state.moveInAfter202606 && !refMoveInOk(d.move_in)) return false;
    if (!refSet(d.source, state.sourcesSelected)) return false;
    if (!refSet(refArrBucket(d.zip_or_arr), state.arrSelected)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// 5. Drive scenarios — every filter is set in one shot via FilterState.replace
//    so we don't depend on per-axis DOM events (those are covered by the
//    wiring runtime test).
// ---------------------------------------------------------------------------
const SCENARIOS = [
  { name: 'empty (no filters)', state: {} },
  { name: 'price 1000-1500',   state: { priceMin: 1000, priceMax: 1500 } },
  { name: 'price open-1000',   state: { priceMax: 1000 } },
  { name: 'price 2000-open',   state: { priceMin: 2000 } },
  { name: 'area 30-60',        state: { areaMin: 30, areaMax: 60 } },
  { name: 'area exactly 30 (boundary)', state: { areaMin: 30, areaMax: 30 } },
  { name: 'rooms T2',          state: { roomsSelected: ['T2'] } },
  { name: 'rooms T1+T4+',      state: { roomsSelected: ['T1', 'T4+'] } },
  { name: 'rooms unknown only', state: { roomsSelected: ['unknown'] } },
  { name: 'rooms full set',    state: { roomsSelected: ['T1','T2','T3','T4+','unknown'] } },
  { name: 'meuble meublé',     state: { meubleSelected: ['meuble'] } },
  { name: 'meuble non',        state: { meubleSelected: ['non'] } },
  { name: 'meuble unknown',    state: { meubleSelected: ['unknown'] } },
  { name: 'move-in gate on',   state: { moveInAfter202606: true } },
  { name: 'sources pap only',  state: { sourcesSelected: ['pap'] } },
  { name: 'sources bbs2+bbs3', state: { sourcesSelected: ['francezone-bbs2','francezone-bbs3'] } },
  { name: 'arr 14+15',         state: { arrSelected: ['14', '15'] } },
  { name: 'arr 92+93+94 (suburbs)', state: { arrSelected: ['92','93','94'] } },
  { name: 'arr unknown only',  state: { arrSelected: ['unknown'] } },
  // Multi-axis combinations
  { name: 'T2 + meublé',                    state: { roomsSelected: ['T2'], meubleSelected: ['meuble'] } },
  { name: 'T2 + price 1000-1500 + meublé',  state: { roomsSelected: ['T2'], priceMin: 1000, priceMax: 1500, meubleSelected: ['meuble'] } },
  { name: 'PAP + T3 + ≥2026-06',            state: { sourcesSelected: ['pap'], roomsSelected: ['T3'], moveInAfter202606: true } },
  { name: 'rooms=T2 + arr=14+15+92+93',     state: { roomsSelected: ['T2'], arrSelected: ['14','15','92','93'] } },
  // Tight / zero-result combinations (proves the filter doesn't quietly
  // leak rows AND that null-field PASS semantics still apply consistently).
  // 5000-6000 is "no row has price in range, but null-price rows pass" → 2 (f01, f03).
  { name: 'price 5000-6000 (only null-price rows pass)', state: { priceMin: 5000, priceMax: 6000 } },
  { name: 'rooms T4+ only + arr 1구 (zero result)',     state: { roomsSelected: ['T4+'], arrSelected: ['1'] } },
  { name: 'sources pap + rooms unknown (zero result)',  state: { sourcesSelected: ['pap'], roomsSelected: ['unknown'] } },
  // Stacked everything
  { name: '7-axis stack (every dimension non-default)', state: {
      priceMin: 800, priceMax: 2200,
      areaMin: 20, areaMax: 70,
      roomsSelected: ['T1','T2','T3'],
      meubleSelected: ['meuble','non'],
      moveInAfter202606: true,
      sourcesSelected: ['francezone-bbs2','francezone-bbs3','pap'],
      arrSelected: ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','92','93','94','unknown'],
    } },
];

// Sanity: confirm the renderer accepted every fixture row (so allEntries=30).
// applyFilters() ran once on initial paint; cluster._layers should hold all 30
// with the empty filter we just installed.
FilterState.reset();
if (cluster._layers.length !== FIXTURE.length) {
  console.error(`FAIL: initial paint added ${cluster._layers.length}/${FIXTURE.length} markers — ` +
                `the fixture must round-trip through the renderer 1:1`);
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// Helper: read the integer the sidebar shows — strip the <strong>…</strong>
// wrapper used by the renderer (`<strong>N</strong> / TOTAL 건`).
function readDisplayedCount() {
  const el = idIndex.get('filter-count');
  if (!el || !el.innerHTML) return null;
  // Match leading "<strong>NN</strong>" — render_map.py emits exactly that.
  const m = /^<strong>(\d+)<\/strong>/.exec(el.innerHTML);
  if (!m) return null;
  return parseInt(m[1], 10);
}

let failures = 0;
function fail(msg) { failures++; console.error('FAIL: ' + msg); }
function pass(msg) { console.log('OK: ' + msg); }

// Verify each scenario.
for (const sc of SCENARIOS) {
  // Replace the WHOLE state in one shot — exercises the same code path the
  // hash-restore handler uses, which is the most realistic "user toggles
  // arbitrary combination" trigger.
  FilterState.replace(sc.state);

  const expected = referenceMatch(FilterState.get());
  const expectedCount = expected.length;
  const expectedIds = new Set(expected.map(d => d.post_id));

  // a) cluster._layers — what's actually shown on the map.
  const shown = cluster._layers.length;
  // b) #filter-count text — the user-facing number.
  const displayed = readDisplayedCount();
  // c) reference count — second source of truth.

  // Cross-check the EXACT marker SET, not just the count, so an off-by-one
  // that's accidentally counted-correctly-but-wrong-row is caught.
  const shownLatLngs = new Set(cluster._layers.map(m => `${m.latlng[0]},${m.latlng[1]}`));
  const expectedLatLngs = new Set(expected.map(d => `${d.lat},${d.lng}`));
  let setMismatch = false;
  if (shownLatLngs.size !== expectedLatLngs.size) setMismatch = true;
  else for (const k of expectedLatLngs) if (!shownLatLngs.has(k)) { setMismatch = true; break; }

  if (shown !== expectedCount) {
    fail(`[${sc.name}] cluster shows ${shown}, reference matches ${expectedCount} ` +
         `(expected ids: ${[...expectedIds].join(',') || '∅'})`);
  } else if (displayed !== expectedCount) {
    fail(`[${sc.name}] sidebar count text shows ${displayed}, reference matches ${expectedCount}`);
  } else if (setMismatch) {
    const shownPostIds = new Set();
    for (const m of cluster._layers) {
      // Reverse-lookup post_id from latlng (lat/lng are unique per fixture row).
      const row = FIXTURE.find(d => d.lat === m.latlng[0] && d.lng === m.latlng[1]);
      if (row) shownPostIds.add(row.post_id);
    }
    fail(`[${sc.name}] count matches (${shown}) but the SET of shown rows differs ` +
         `from reference: shown=${[...shownPostIds].sort().join(',')} ` +
         `expected=${[...expectedIds].sort().join(',')}`);
  } else {
    pass(`[${sc.name}] cluster=${shown}, sidebar=${displayed}, reference=${expectedCount} (rows match)`);
  }
}

// ---------------------------------------------------------------------------
// 6. Cleanup + summary
// ---------------------------------------------------------------------------
rmSync(td, { recursive: true, force: true });
console.log('');
if (failures) {
  console.error(`verify_filter_count_parity: ${failures} FAILURE(S) across ${SCENARIOS.length} scenarios`);
  process.exit(1);
}
console.log(`verify_filter_count_parity: all ${SCENARIOS.length} scenarios passed — ` +
            `visible pin count = data matching count, exactly ✓`);
