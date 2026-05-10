#!/usr/bin/env node
/**
 * Sub-AC 1.5.3 verifier — exercises the URL-hash serialization/deserialization
 * embedded in the rendered paris-realestate.html and proves a no-loss
 * round-trip for arbitrary filter combinations.
 *
 * What it checks (the AC's own exit criteria):
 *   1. FilterHash module is exposed (serialize / parse / isFilterHash).
 *   2. serialize(defaults) === ''   (empty hash means "no filter").
 *   3. parse('') yields defaults.
 *   4. Each of the 7 axes round-trips through serialize → parse without loss
 *      (price, area, rooms, meuble, move-in, sources, arr) — incl. the open-
 *      ended price/area bound encodings ('400-', '-1500'), the T4+ chip whose
 *      '+' must percent-encode safely, and CSV multi-selects.
 *   5. End-to-end DOM ⇄ URL bridge: setting filters via DOM mutates
 *      location.hash; calling restoreFromHash() with a hash mutates
 *      FilterState AND syncs DOM controls.
 *   6. The legacy openHash() deep-link format ('#francezone-bbs2:42') is
 *      preserved — restoreFromHash() does NOT touch state for it, and
 *      writeHashFromState() does NOT clobber it when state is at defaults.
 *   7. Five hand-rolled sample hashes from the Seed roundtrip exit criterion
 *      survive serialize → parse (and parse → serialize → parse for
 *      idempotence).
 *
 * Run from repo root:  node scripts/paris-rental/verify_hash_roundtrip.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const RENDERER = path.join(
  REPO_ROOT, 'container', 'skills', 'paris-rental-watch', 'render_map.py'
);

// Same fixture as verify_filter_wiring_runtime.mjs (4 listings spanning the
// full chip vocabulary) so the DOM-mutation tests have something to filter.
const FIXTURE = [
  {
    namespaced_id: 'fz-bbs2:1', post_id: '1', source: 'francezone-bbs2',
    title: 'T2 14e', url: 'https://example.com/1', verdict: 'pass',
    lat: 48.83, lng: 2.32, location_text: '14e',
    price_eur: 1200, area_m2: 35, move_in: '2026-06-01',
    rooms: 'T2', meuble: 'meuble', zip_or_arr: '75014',
  },
  {
    namespaced_id: 'pap:2', post_id: '2', source: 'pap',
    title: 'T3 11e', url: 'https://example.com/2', verdict: 'pass',
    lat: 48.85, lng: 2.37, location_text: '11e',
    price_eur: 1800, area_m2: 55, move_in: 'flexible',
    rooms: 'T3', meuble: 'non', zip_or_arr: '75011',
  },
  {
    namespaced_id: 'fz-bbs3:3', post_id: '3', source: 'francezone-bbs3',
    title: 'T1 92', url: 'https://example.com/3', verdict: 'ambiguous',
    lat: 48.88, lng: 2.24, location_text: 'Boulogne',
    price_eur: 900, area_m2: 22, move_in: null,
    rooms: 'T1', meuble: 'unknown', zip_or_arr: '92100',
  },
  {
    namespaced_id: 'fz-bbs2:4', post_id: '4', source: 'francezone-bbs2',
    title: 'T4+ 1e', url: 'https://example.com/4', verdict: 'pass',
    lat: 48.86, lng: 2.34, location_text: '1e',
    price_eur: 2400, area_m2: 80, move_in: '2025-09-01',
    rooms: 'T4+', meuble: 'meuble', zip_or_arr: '75001',
  },
];

// --------------------------------------------------------------------------
// 1. Render HTML
// --------------------------------------------------------------------------
const td = mkdtempSync(path.join(tmpdir(), 'parishash-'));
const jsonl = path.join(td, 'l.jsonl');
const out   = path.join(td, 'out.html');
const kml   = path.join(td, 'out.kml');
writeFileSync(jsonl, FIXTURE.map(d => JSON.stringify(d)).join('\n') + '\n');
execFileSync(
  'python3', [RENDERER, jsonl, out, kml, '2026-05-09T22:00:00+02:00'],
  { stdio: 'pipe' }
);
const html = readFileSync(out, 'utf-8');

// --------------------------------------------------------------------------
// 2. Extract every inline <script> body.
// --------------------------------------------------------------------------
const scriptBlocks = [];
const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  const body  = m[2] || '';
  if (/\bsrc=/.test(attrs)) continue;
  if (body.trim()) scriptBlocks.push(body);
}
if (scriptBlocks.length === 0) {
  console.error('FAIL: no inline <script> blocks found in rendered HTML');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}

// --------------------------------------------------------------------------
// 3. DOM + Leaflet shim — a minimal subset, identical to the wiring test.
// --------------------------------------------------------------------------
function makeClassList(initial){
  const set = new Set(initial || []);
  return {
    add: (...n) => n.forEach(x => set.add(x)),
    remove: (...n) => n.forEach(x => set.delete(x)),
    contains: (n) => set.has(n),
    toggle: (n, force) => {
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      return want;
    },
    [Symbol.iterator]: () => set[Symbol.iterator](),
    get size(){ return set.size; },
    _set: set,
  };
}

class FakeNode {
  constructor(spec = {}){
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
  addEventListener(evt, fn){ (this.listeners[evt] ||= []).push(fn); }
  removeEventListener(evt, fn){
    const a = this.listeners[evt]; if (!a) return;
    const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1);
  }
  dispatchEvent(evt){
    const t = typeof evt === 'string' ? evt : evt.type;
    for (const fn of (this.listeners[t] || []).slice()) fn(evt || { type: t });
  }
  setAttribute(k, v){ this.attrs[k] = v; }
  getAttribute(k){ return this.attrs[k]; }
  get className(){ return [...this.classList].join(' '); }
  set className(s){
    this.classList = makeClassList(String(s || '').split(/\s+/).filter(Boolean));
  }
}

function makeNodes(){
  const idIndex = new Map();
  const classIndex = new Map();
  const all = [];
  function add(spec){
    const n = new FakeNode(spec);
    if (n.id) idIndex.set(n.id, n);
    for (const c of (spec.classes || [])){
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
  function chips(cls, values){
    return values.map(v => add({
      tag: 'input', classes: [cls],
      attrs: { type: 'checkbox', value: v }, value: v,
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
    id: 'filter-movein', tag: 'input', classes: ['filter-movein'],
    attrs: { type: 'checkbox' },
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
  getElementById(id){ return idIndex.get(id) || null; },
  querySelector(sel){ const list = this.querySelectorAll(sel); return list[0] || null; },
  querySelectorAll(sel){
    if (sel.includes('#sidebar-content')){
      return all.filter(n => n.tag === 'input' && n.attrs.type === 'checkbox');
    }
    const results = new Set();
    for (let part of sel.split(',')){
      part = part.trim();
      let checkedOnly = false;
      if (part.endsWith(':checked')){ checkedOnly = true; part = part.slice(0, -':checked'.length); }
      const m = /^input\.([\w-]+)$/.exec(part);
      if (!m) continue;
      const list = classIndex.get(m[1]) || [];
      for (const n of list){
        if (checkedOnly && !n.checked) continue;
        results.add(n);
      }
    }
    return [...results];
  },
  body: fakeBody,
  addEventListener(){}, removeEventListener(){},
};

const clusterAddLayersCalls = [];
const allMarkers = [];
let cluster;
const L = {
  map: () => {
    const m = {}; m.setView = () => m; m.addLayer = () => m;
    m.fitBounds = () => m; m.invalidateSize = () => m;
    return m;
  },
  tileLayer: () => { const t = {}; t.addTo = () => t; return t; },
  marker: (latlng) => {
    const mk = { latlng, bindPopup(){ return this; }, getLatLng(){ return latlng; }, openPopup(){} };
    allMarkers.push(mk); return mk;
  },
  divIcon: () => ({}),
  markerClusterGroup: () => {
    cluster = {
      _layers: [],
      clearLayers(){ this._layers = []; },
      addLayers(arr){ this._layers = this._layers.concat(arr); clusterAddLayersCalls.push(arr.length); },
      addLayer(){},
      zoomToShowLayer(_, cb){ cb && cb(); },
    };
    return cluster;
  },
  latLngBounds: (pts) => ({ pad: () => pts }),
};

function requestAnimationFrame(fn){ fn(); return 0; }
const localStorage = {
  _: new Map(),
  getItem(k){ return this._.has(k) ? this._.get(k) : null; },
  setItem(k, v){ this._.set(k, String(v)); },
};

// `location` and `history` are mutable in this sandbox so the wiring code can
// observe its own writes. `window.addEventListener` records hashchange
// listeners so we can fire them synthetically.
const windowListeners = {};
const sandboxWindow = {
  innerWidth: 1024,
  addEventListener(evt, fn){ (windowListeners[evt] ||= []).push(fn); },
  removeEventListener(){},
};
const location = { hash: '', pathname: '/paris-realestate.html', search: '' };
const history = {
  replaceState(_a, _b, url){
    // Mirror real history.replaceState: parse the URL and update location.
    // We only care about the hash portion for these tests.
    const i = url.indexOf('#');
    location.hash = i === -1 ? '' : url.slice(i);
    // replaceState does NOT fire hashchange (that's the whole point).
  },
};

// --------------------------------------------------------------------------
// 4. Run the rendered script in a vm sandbox + epilogue exposing internals.
// --------------------------------------------------------------------------
const sandbox = {
  document, window: sandboxWindow, location, history,
  L, localStorage, requestAnimationFrame,
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const epilogue = `
;try { globalThis.FilterState = FilterState; } catch(e){}
;try { globalThis.applyFilters = applyFilters; } catch(e){}
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
const FilterHash  = sandbox.FilterHash;

// --------------------------------------------------------------------------
// 5. Assertions
// --------------------------------------------------------------------------
let failures = 0;
function assert(label, cond, detail){
  const status = cond ? 'OK' : 'FAIL';
  console.log(`[${status}] ${label}: ${detail}`);
  if (!cond) failures++;
}

// (1) FilterHash is exposed
assert('FilterHash exposed',
  FilterHash &&
    typeof FilterHash.serialize === 'function' &&
    typeof FilterHash.parse     === 'function' &&
    typeof FilterHash.isFilterHash === 'function',
  'globalThis.FilterHash must expose serialize / parse / isFilterHash');

if (!FilterHash){ rmSync(td, { recursive: true, force: true }); process.exit(1); }

// (2) Defaults round-trip cleanly: empty body in, defaults out.
const DEFAULTS = {
  priceMin: null, priceMax: null,
  areaMin:  null, areaMax:  null,
  roomsSelected: [], meubleSelected: [],
  moveInAfter202606: false,
  sourcesSelected: [], arrSelected: [], metroLinesSelected: [],
};
function eqState(a, b){
  return JSON.stringify(a) === JSON.stringify(b);
}
function freeze(s){
  // Snapshot in canonical form (matches DEFAULTS shape) for comparison.
  return {
    priceMin: s.priceMin ?? null, priceMax: s.priceMax ?? null,
    areaMin:  s.areaMin  ?? null, areaMax:  s.areaMax  ?? null,
    roomsSelected:      (s.roomsSelected  || []).slice(),
    meubleSelected:     (s.meubleSelected || []).slice(),
    moveInAfter202606:  !!s.moveInAfter202606,
    sourcesSelected:    (s.sourcesSelected    || []).slice(),
    arrSelected:        (s.arrSelected        || []).slice(),
    metroLinesSelected: (s.metroLinesSelected || []).slice(),
  };
}
assert('serialize(defaults) is empty',
  FilterHash.serialize(DEFAULTS) === '',
  `got ${JSON.stringify(FilterHash.serialize(DEFAULTS))}`);
assert('parse("") returns defaults',
  eqState(freeze(FilterHash.parse('')), DEFAULTS),
  JSON.stringify(FilterHash.parse('')));

// (3) Per-axis round-trip — for each canonical sample, serialize then parse
// and assert the parsed state matches the input (canonical shape).
const PER_AXIS_SAMPLES = [
  ['price both bounds',   { ...DEFAULTS, priceMin: 400, priceMax: 1500 }],
  ['price min only',      { ...DEFAULTS, priceMin: 400 }],
  ['price max only',      { ...DEFAULTS, priceMax: 1500 }],
  ['area both bounds',    { ...DEFAULTS, areaMin: 20, areaMax: 50 }],
  ['rooms multi+T4+',     { ...DEFAULTS, roomsSelected: ['T2', 'T3', 'T4+'] }],
  ['rooms unknown',       { ...DEFAULTS, roomsSelected: ['unknown'] }],
  ['meuble single',       { ...DEFAULTS, meubleSelected: ['meuble'] }],
  ['meuble all 3',        { ...DEFAULTS, meubleSelected: ['meuble', 'non', 'unknown'] }],
  ['movein on',           { ...DEFAULTS, moveInAfter202606: true }],
  ['sources subset',      { ...DEFAULTS, sourcesSelected: ['francezone-bbs2', 'pap'] }],
  ['arr 1+14+92',         { ...DEFAULTS, arrSelected: ['1', '14', '92'] }],
  ['line metro+RER+T',    { ...DEFAULTS, metroLinesSelected: ['M14', 'RER-A', 'T3a'] }],
];
for (const [label, snap] of PER_AXIS_SAMPLES){
  const body = FilterHash.serialize(snap);
  const back = freeze(FilterHash.parse(body));
  assert(`round-trip ${label}`, eqState(back, snap),
    `serialize→parse: hash="${body}" → ${JSON.stringify(back)}`);
}

// (4) Five Seed-style sample hashes — including formats explicitly mentioned
// in the Seed (`#price=400-1500&rooms=T2,T3&line=14`). The "5개 샘플" exit
// criterion lives at the parent AC; we exercise its logic here.
const SEED_HASHES = [
  '#price=400-1500&rooms=T2,T3&line=M14',
  '#area=20-50&meuble=meuble&movein=1',
  '#rooms=T1,T2,T3,T4+&sources=pap',
  '#arr=14,15,92&line=RER-A,M14',
  '#price=750-1200&area=30-50&rooms=T2,T3&meuble=meuble&movein=1&sources=francezone-bbs3,pap&arr=11,14&line=M14',
];
for (const sample of SEED_HASHES){
  const parsed = FilterHash.parse(sample);
  const reSer  = FilterHash.serialize(parsed);
  const reParsed = FilterHash.parse(reSer);
  assert(`seed-sample idempotent: ${sample}`,
    eqState(freeze(parsed), freeze(reParsed)),
    `parse → serialize → parse: "${reSer}"`);
  // Also confirm the serialized form is itself a filter hash.
  assert(`seed-sample isFilterHash`,
    FilterHash.isFilterHash('#' + reSer),
    `"#${reSer}" should be a filter hash`);
}

// (5) Open-ended bounds survive: '400-' and '-1500' formats specifically.
{
  const a = freeze(FilterHash.parse('#price=400-'));
  assert('parse "price=400-"',
    a.priceMin === 400 && a.priceMax === null,
    JSON.stringify(a));
  const b = freeze(FilterHash.parse('#price=-1500'));
  assert('parse "price=-1500"',
    b.priceMin === null && b.priceMax === 1500,
    JSON.stringify(b));
}

// (6) Coexistence with deep-link: bare-id hashes are NOT filter hashes.
assert('isFilterHash("#francezone-bbs2:42") is false',
  FilterHash.isFilterHash('#francezone-bbs2:42') === false,
  'deep-link IDs (no "=" anywhere) must not be treated as filter hashes');
assert('isFilterHash("") is false',
  FilterHash.isFilterHash('') === false, 'empty hash is not a filter hash');
assert('isFilterHash("#") is false',
  FilterHash.isFilterHash('#') === false, 'bare # is not a filter hash');
assert('isFilterHash("#rooms=T2") is true',
  FilterHash.isFilterHash('#rooms=T2') === true, 'filter hashes contain "="');

// (7) End-to-end DOM ⇄ URL bridge — toggle DOM controls and confirm URL.
function toggleChip(cls, value, checked = true){
  const list = classIndex.get(cls) || [];
  const el = list.find(n => n.attrs.value === value);
  if (!el) throw new Error(`chip not found: ${cls}=${value}`);
  el.checked = checked;
  el.dispatchEvent({ type: 'change' });
}
function setRange(id, val){
  const el = idIndex.get(id);
  el.value = val == null ? '' : String(val);
  el.dispatchEvent({ type: 'input' });
}
function fireHashChange(){
  for (const fn of (windowListeners['hashchange'] || []).slice()) fn();
}

// Reset to clean state via the existing reset button so we don't carry state
// across test cases.
function reset(){
  idIndex.get('filter-reset').dispatchEvent({ type: 'click' });
}
reset();

// 7a. Toggling DOM controls writes to the hash via history.replaceState.
toggleChip('filter-rooms', 'T2');
toggleChip('filter-rooms', 'T3');
setRange('filter-price-min', 400);
setRange('filter-price-max', 1500);
toggleChip('filter-meuble', 'meuble');
assert('DOM toggles write hash',
  location.hash.startsWith('#') &&
    /price=400-1500/.test(location.hash) &&
    /rooms=T2,T3/.test(location.hash) &&
    /meuble=meuble/.test(location.hash),
  `location.hash=${location.hash}`);

// 7b. Reset clears the hash.
reset();
assert('reset clears hash',
  location.hash === '' || location.hash === '#',
  `location.hash=${location.hash}`);

// 7c. External URL change → hashchange → state restored AND DOM synced.
location.hash = '#price=750-1200&rooms=T2,T3&meuble=meuble&movein=1&arr=14,15&line=M14';
fireHashChange();

const restored = freeze(FilterState.get());
assert('hashchange → state.priceMin', restored.priceMin === 750, `got ${restored.priceMin}`);
assert('hashchange → state.priceMax', restored.priceMax === 1200, `got ${restored.priceMax}`);
assert('hashchange → state.rooms',
  restored.roomsSelected.length === 2 && restored.roomsSelected.includes('T2') && restored.roomsSelected.includes('T3'),
  JSON.stringify(restored.roomsSelected));
assert('hashchange → state.meuble',
  restored.meubleSelected.length === 1 && restored.meubleSelected[0] === 'meuble',
  JSON.stringify(restored.meubleSelected));
assert('hashchange → state.movein', restored.moveInAfter202606 === true, String(restored.moveInAfter202606));
assert('hashchange → state.arr',
  restored.arrSelected.length === 2 && restored.arrSelected.includes('14') && restored.arrSelected.includes('15'),
  JSON.stringify(restored.arrSelected));
assert('hashchange → state.line',
  restored.metroLinesSelected.length === 1 && restored.metroLinesSelected[0] === 'M14',
  JSON.stringify(restored.metroLinesSelected));

// 7d. DOM also synced after hash restore.
assert('DOM synced: filter-price-min',
  idIndex.get('filter-price-min').value === '750',
  `got "${idIndex.get('filter-price-min').value}"`);
assert('DOM synced: filter-price-max',
  idIndex.get('filter-price-max').value === '1200',
  `got "${idIndex.get('filter-price-max').value}"`);
assert('DOM synced: filter-movein checked',
  idIndex.get('filter-movein').checked === true,
  String(idIndex.get('filter-movein').checked));
function isChecked(cls, v){
  const el = (classIndex.get(cls) || []).find(n => n.attrs.value === v);
  return el ? el.checked : null;
}
assert('DOM synced: rooms T2', isChecked('filter-rooms', 'T2') === true,
  String(isChecked('filter-rooms', 'T2')));
assert('DOM synced: rooms T3', isChecked('filter-rooms', 'T3') === true,
  String(isChecked('filter-rooms', 'T3')));
assert('DOM synced: rooms T1 (unchecked)',
  isChecked('filter-rooms', 'T1') === false,
  String(isChecked('filter-rooms', 'T1')));
assert('DOM synced: arr 14', isChecked('filter-arr', '14') === true,
  String(isChecked('filter-arr', '14')));
assert('DOM synced: meuble meuble', isChecked('filter-meuble', 'meuble') === true,
  String(isChecked('filter-meuble', 'meuble')));

// 7e. Manually setting a deep-link hash does NOT clobber filter state.
const beforeLegacy = freeze(FilterState.get());
location.hash = '#francezone-bbs2:42';
fireHashChange();
const afterLegacy = freeze(FilterState.get());
assert('deep-link hash preserves filter state',
  eqState(beforeLegacy, afterLegacy),
  `before=${JSON.stringify(beforeLegacy)}\n      after=${JSON.stringify(afterLegacy)}`);

// 7f. After reset (state at defaults) writeHashFromState must NOT clobber
// the deep-link hash that's currently in the URL.
reset();
assert('reset does not clobber deep-link hash',
  location.hash === '#francezone-bbs2:42',
  `location.hash=${location.hash} (should preserve deep-link)`);

// 7g. Refresh-style restore: a fresh page load with a filter hash should
// produce filtered markers via applyFilters. We emulate this by setting the
// hash and re-firing restoreFromHash() — applyFilters runs, cluster updates.
location.hash = '#rooms=T2';
fireHashChange();
const lastVisible = clusterAddLayersCalls.at(-1);
assert('refresh-style restore filters cluster',
  lastVisible === 1,
  `cluster.addLayers got ${lastVisible} markers (expected 1: only T2)`);

// --------------------------------------------------------------------------
// 6. Cleanup + summary
// --------------------------------------------------------------------------
rmSync(td, { recursive: true, force: true });
console.log();
if (failures){
  console.error(`verify_hash_roundtrip: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('verify_hash_roundtrip: URL-hash serialization round-trip ✓');
