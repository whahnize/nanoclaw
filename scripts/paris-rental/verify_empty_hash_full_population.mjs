#!/usr/bin/env node
/**
 * AC 4 verifier — "빈 hash 또는 hash 없음 → 전체 182건 표시".
 *
 * Empty / missing URL hash MUST leave the FilterState at defaults so that
 * every one of the 182 historical listings is visible in the cluster on
 * first paint. This is the contract a fresh visitor or a refresh-from-clean-
 * URL relies on. Any silent default that accidentally selected a chip, set
 * a numeric range, or activated the move-in toggle would shrink the visible
 * pin set below 182 and break user trust on the most common entry path.
 *
 * Strategy (independent of `verify_hash_refresh_restore.mjs` which uses an
 * 8-row fixture):
 *
 *   1. Synthesize a 182-row fixture covering every chip value and every
 *      "missing field" combination, so the count is exactly 182 only if the
 *      filter predicate degenerates to "everything passes" for the default
 *      state. Any partially-populated default would drop SOME of these rows.
 *   2. Render the page once via the canonical
 *      container/skills/paris-rental-watch/render_map.py.
 *   3. For each of THREE initial-hash scenarios — '' (no fragment in URL,
 *      which is exactly what the WHATWG URL spec hands you when the page
 *      has no '#' at all), '#' (literal-hash-only, empty body), and a bare
 *      deep-link id like '#fz-bbs2:5' (no '=' so the filter parser must
 *      ignore it and openHash takes over) — boot the inline script bundle
 *      in a hermetic vm sandbox and assert FOUR things:
 *        a) FilterState.get() exactly equals the documented defaults.
 *        b) cluster._layers.length === 182  (initial paint + applyFilters
 *           together leave 182 markers attached).
 *        c) The #filter-count UI shows "<strong>182</strong> / 182 건".
 *        d) location.hash is unchanged after init — the writer must NOT
 *           pollute a clean URL with an empty/default-state hash and must
 *           NOT clobber a bare-id deep-link hash.
 *
 * Exits non-zero on any failure with a verbose diff for reproducibility.
 *
 * Run from the repo root:
 *
 *     node scripts/paris-rental/verify_empty_hash_full_population.mjs
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
const TARGET_COUNT = 182;

// ---------------------------------------------------------------------------
// 1. Build a 182-row fixture spanning every dimension's chip values plus the
//    "missing field" sub-buckets. The intent is that NO subset of defaults
//    that filtered anything out would ever produce 182 — the test fails fast
//    if the renderer accidentally activates a filter on init.
// ---------------------------------------------------------------------------
const SOURCES = ['francezone-bbs2', 'francezone-bbs3', 'pap'];
const ROOMS   = ['T1', 'T2', 'T3', 'T4+', 'unknown', null];
const MEUBLE  = ['meuble', 'non', 'unknown', null];
// Mix of Paris (75001-75020), inner suburbs (92/93/94), the explicit unknown
// bucket (out-of-area zip), and missing zip → bucketed as 'unknown'.
const ZIPS = [
  '75001','75002','75003','75004','75005','75006','75007','75008','75009','75010',
  '75011','75012','75013','75014','75015','75016','75017','75018','75019','75020',
  '92100','92200','92500','93100','93200','94200','94300',
  '78100', null, // out-of-area + missing → 'unknown' arr bucket
];
// move_in vocabulary spans before 2026-06, ≥ 2026-06, exact boundary, "flexible",
// unparseable, and missing — covers every branch in moveInOk().
const MOVE_INS = [
  '2025-04-01', '2025-09-01', '2025-12-31',
  '2026-06-01', '2026-06-15', '2026-07-01', '2026-08-01', '2026-09-01',
  '2027-01-01',
  'flexible', 'à discuter', '', null,
];
// Metro-line vocabulary: representative subset including RER and tram chips,
// plus listings without metro_lines at all (geocoded via fallback). These
// MUST still be visible under defaults — the metro filter is empty so it's
// a no-op.
const LINE_BUCKETS = [
  ['M1'], ['M2', 'M11'], ['M4'], ['M6', 'M13'], ['M9'],
  ['M10', 'RER C'], ['M12'], ['M14'], ['RER A'], ['RER B'],
  ['T3a'], ['T3b'], null, [],
];

function pickDeterministic(arr, i){
  return arr[i % arr.length];
}

// Generate exactly 182 listings. Distribution is intentionally non-uniform so
// no single axis dominates and the count would visibly change if any filter
// were active by mistake.
const FIXTURE = [];
for (let i = 0; i < TARGET_COUNT; i++){
  const source = pickDeterministic(SOURCES, i);
  const rooms  = pickDeterministic(ROOMS, i + 1);
  const meuble = pickDeterministic(MEUBLE, i + 2);
  const zip    = pickDeterministic(ZIPS, i + 3);
  const moveIn = pickDeterministic(MOVE_INS, i + 4);
  const lines  = pickDeterministic(LINE_BUCKETS, i + 5);
  // Price/area: include explicit nulls every 17/19 rows so missing-numeric
  // listings are part of the 182 (range filter must let them pass when
  // bounds are null — i.e. inRange(null, null, null) === true).
  const price = (i % 17 === 0) ? null : (700 + (i * 11) % 2400);
  const area  = (i % 19 === 0) ? null : (15  + (i * 7)  % 80);
  const post_id = `ac4-${i.toString().padStart(3, '0')}`;
  const ns = (source === 'pap') ? 'pap'
           : (source === 'francezone-bbs3' ? 'fz-bbs3' : 'fz-bbs2');
  const row = {
    namespaced_id: `${ns}:${post_id}`,
    post_id,
    source,
    title: `${post_id} ${rooms || 'unknown'} ${zip || 'noaddr'}`,
    url: `https://example.com/${post_id}`,
    verdict: (i % 5 === 0) ? 'ambiguous' : 'pass',
    lat: 48.83 + ((i * 13) % 100) * 0.001,
    lng: 2.30  + ((i * 17) % 100) * 0.001,
    location_text: zip || 'unknown',
    price_eur: price,
    area_m2:   area,
    move_in:   moveIn,
    rooms,
    meuble,
    zip_or_arr: zip,
  };
  if (lines !== null) row.metro_lines = lines;
  FIXTURE.push(row);
}
if (FIXTURE.length !== TARGET_COUNT){
  console.error(`FAIL: fixture builder produced ${FIXTURE.length} rows, want ${TARGET_COUNT}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Render the canonical HTML once, extract the inline scripts (we re-eval
//    in a fresh vm context per scenario so each "boot" is hermetic).
// ---------------------------------------------------------------------------
const td = mkdtempSync(path.join(tmpdir(), 'parisAC4-'));
const jsonl = path.join(td, 'l.jsonl');
const out   = path.join(td, 'out.html');
const kml   = path.join(td, 'out.kml');
writeFileSync(jsonl, FIXTURE.map(d => JSON.stringify(d)).join('\n') + '\n');
execFileSync(
  'python3', [RENDERER, jsonl, out, kml, '2026-05-09T22:00:00+02:00'],
  { stdio: 'pipe' }
);
const html = readFileSync(out, 'utf-8');

const scriptBlocks = [];
{
  const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const body  = m[2] || '';
    if (/\bsrc=/.test(attrs)) continue;
    if (body.trim()) scriptBlocks.push(body);
  }
}
if (scriptBlocks.length === 0){
  console.error('FAIL: no inline <script> blocks in rendered HTML');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}
const SCRIPT_BUNDLE = scriptBlocks.join(';\n;') + `
;try { globalThis.FilterState = FilterState; } catch(e){}
;try { globalThis.applyFilters = applyFilters; } catch(e){}
`;

// ---------------------------------------------------------------------------
// 3. DOM + Leaflet shim — minimal but faithful to the renderer's queries.
//    Mirrors verify_hash_refresh_restore.mjs's sandbox so semantics drift
//    (if any) is caught by both tests in lock-step.
// ---------------------------------------------------------------------------
function buildSandbox(initialHashSpec){
  // initialHashSpec is one of:
  //   { kind: 'empty' }         → location.hash = '' (no fragment in URL)
  //   { kind: 'literal' }       → location.hash = '#' (literal '#' with empty body)
  //   { kind: 'deeplink', id }  → location.hash = '#' + id  (no '=')
  //
  // We deliberately do NOT exercise a `location` object with no `.hash`
  // property at all: the WHATWG URL spec guarantees Location.hash is always
  // at least the empty string in real browsers, so simulating an undefined
  // .hash would only test fictional environments and uncovers a crash in
  // openHash() (line ~398) that no production user can ever hit.
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
  const idIndex = new Map();
  const classIndex = new Map();
  const all = [];
  function addNode(spec){
    const n = new FakeNode(spec);
    if (n.id) idIndex.set(n.id, n);
    for (const c of (spec.classes || [])){
      if (!classIndex.has(c)) classIndex.set(c, []);
      classIndex.get(c).push(n);
    }
    all.push(n);
    return n;
  }
  addNode({ id: 'filter-price-min', tag: 'input', attrs: { type: 'number' } });
  addNode({ id: 'filter-price-max', tag: 'input', attrs: { type: 'number' } });
  addNode({ id: 'filter-area-min',  tag: 'input', attrs: { type: 'number' } });
  addNode({ id: 'filter-area-max',  tag: 'input', attrs: { type: 'number' } });
  function chips(cls, values){
    return values.map(v => addNode({
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
  chips('filter-line', ['M1','M2','M4','M5','M6','M9','M10','M11','M12','M13','M14',
                        'RER-A','RER-B','RER-C','T3a','T3b']);
  addNode({ id: 'filter-movein', tag: 'input', classes: ['filter-movein'],
    attrs: { type: 'checkbox' } });
  addNode({ id: 'sidebar', tag: 'aside' });
  addNode({ id: 'sidebar-toggle', tag: 'button' });
  addNode({ id: 'sidebar-side-btn', tag: 'button' });
  addNode({ id: 'sidebar-content', tag: 'div' });
  addNode({ id: 'filter-count', tag: 'span' });
  addNode({ id: 'filter-reset', tag: 'button' });
  addNode({ id: 'map', tag: 'div' });
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
  let cluster;
  const L = {
    map: () => {
      const m = {}; m.setView = () => m; m.addLayer = () => m;
      m.fitBounds = () => m; m.invalidateSize = () => m; return m;
    },
    tileLayer: () => { const t = {}; t.addTo = () => t; return t; },
    marker: (latlng) => ({
      latlng, bindPopup(){ return this; },
      getLatLng(){ return latlng; }, openPopup(){},
    }),
    divIcon: () => ({}),
    markerClusterGroup: () => {
      cluster = {
        _layers: [],
        clearLayers(){ this._layers = []; },
        addLayers(arr){
          this._layers = this._layers.concat(arr);
          clusterAddLayersCalls.push(arr.length);
        },
        addLayer(){},
        zoomToShowLayer(_, cb){ cb && cb(); },
      };
      return cluster;
    },
    latLngBounds: (pts) => ({ pad: () => pts }),
  };
  const localStorage = {
    _: new Map(),
    getItem(k){ return this._.has(k) ? this._.get(k) : null; },
    setItem(k, v){ this._.set(k, String(v)); },
  };
  const windowListeners = {};
  const sandboxWindow = {
    innerWidth: 1024,
    addEventListener(evt, fn){ (windowListeners[evt] ||= []).push(fn); },
    removeEventListener(){},
  };
  // Build `location` per the requested initial-hash scenario. The 'missing'
  // case really omits the property so we exercise the `(location.hash) || ''`
  // fallback in restoreFromHash (a `||` against undefined returns '').
  let location;
  if (initialHashSpec.kind === 'empty'){
    location = { hash: '', pathname: '/paris-realestate.html', search: '' };
  } else if (initialHashSpec.kind === 'literal'){
    location = { hash: '#', pathname: '/paris-realestate.html', search: '' };
  } else if (initialHashSpec.kind === 'deeplink'){
    location = { hash: '#' + initialHashSpec.id, pathname: '/paris-realestate.html', search: '' };
  } else {
    throw new Error('unknown initialHashSpec.kind: ' + initialHashSpec.kind);
  }
  const history = {
    replaceState(_a, _b, url){
      const i = url.indexOf('#');
      location.hash = i === -1 ? '' : url.slice(i);
    },
  };
  const sandbox = {
    document, window: sandboxWindow, location, history,
    L, localStorage,
    requestAnimationFrame: (fn) => { fn(); return 0; },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  return {
    sandbox, idIndex, classIndex, location, clusterAddLayersCalls,
    getCluster: () => cluster,
  };
}

// ---------------------------------------------------------------------------
// 4. Run each empty-hash scenario.
// ---------------------------------------------------------------------------
let failures = 0;
function assert(label, cond, detail){
  const status = cond ? 'OK' : 'FAIL';
  console.log(`[${status}] ${label}: ${detail}`);
  if (!cond) failures++;
}

const SCENARIOS = [
  { kind: 'empty',    label: "location.hash = '' (no fragment in URL)" },
  { kind: 'literal',  label: "location.hash = '#' (literal hash, empty body)" },
  { kind: 'deeplink', label: "location.hash = '#fz-bbs2:ac4-005' (bare-id deep link)",
    id: 'fz-bbs2:ac4-005' },
];

for (const s of SCENARIOS){
  const env = buildSandbox(s);
  vm.createContext(env.sandbox);
  try {
    vm.runInContext(SCRIPT_BUNDLE, env.sandbox, { filename: `boot:${s.label}` });
  } catch (e) {
    assert(`boot: ${s.label}`, false, `script threw: ${e.message}`);
    continue;
  }

  // 4.1 — FilterState is at the documented defaults.
  const state = env.sandbox.FilterState ? env.sandbox.FilterState.get() : null;
  if (!state){
    assert(`[${s.label}] FilterState exposed`, false, 'FilterState not on sandbox');
    continue;
  }
  const isDefault =
    state.priceMin === null && state.priceMax === null &&
    state.areaMin  === null && state.areaMax  === null &&
    Array.isArray(state.roomsSelected)      && state.roomsSelected.length      === 0 &&
    Array.isArray(state.meubleSelected)     && state.meubleSelected.length     === 0 &&
    state.moveInAfter202606 === false &&
    Array.isArray(state.sourcesSelected)    && state.sourcesSelected.length    === 0 &&
    Array.isArray(state.arrSelected)        && state.arrSelected.length        === 0 &&
    Array.isArray(state.metroLinesSelected) && state.metroLinesSelected.length === 0;
  assert(`[${s.label}] state at defaults`, isDefault, JSON.stringify(state));

  // 4.2 — Cluster currently holds exactly TARGET_COUNT markers. The runtime
  // adds markers in TWO phases: (a) the unconditional initial paint at line
  // ~390 (`cluster.addLayers(allEntries.map(...))`), and (b) applyFilters()
  // at the bottom of initRangeFilters (which clears + re-adds). After both,
  // _layers must equal 182. We assert _layers length, NOT just the last
  // addLayers() arg, so partial wipes / double-adds also fail loudly.
  const cluster = env.getCluster();
  assert(`[${s.label}] cluster._layers length`,
    cluster && cluster._layers.length === TARGET_COUNT,
    `got ${cluster && cluster._layers.length}, want ${TARGET_COUNT}`);

  // 4.3 — The sidebar count UI shows "182 / 182 건". This is the number the
  // user actually sees, so checking it independently of the cluster size
  // catches drift between the marker layer and the count display.
  const countEl = env.idIndex.get('filter-count');
  const expected = `<strong>${TARGET_COUNT}</strong> / ${TARGET_COUNT} 건`;
  assert(`[${s.label}] #filter-count text`,
    countEl && countEl.innerHTML === expected,
    `got "${countEl && countEl.innerHTML}", want "${expected}"`);

  // 4.4 — location.hash invariants. Empty/missing/literal-hash MUST stay
  // empty (writer must not pollute a clean URL with an empty filter body).
  // Bare-id deep-link hash MUST be preserved (writer must not clobber it
  // when filter state is at defaults — the share-by-id feature depends on
  // it surviving init).
  const cur = env.location.hash || '';
  if (s.kind === 'deeplink'){
    assert(`[${s.label}] deep-link hash preserved`,
      cur === '#' + s.id,
      `got "${cur}", want "#${s.id}"`);
  } else if (s.kind === 'literal'){
    // The writer at line ~911 returns early when body === '' AND cur is
    // '' or non-filter. '#' is non-filter (no '='), so it stays untouched.
    // Its EXACT preservation isn't user-visible (browsers normalize '#'
    // to '' in the URL bar), but the runtime should still leave it alone.
    assert(`[${s.label}] literal '#' hash not clobbered`,
      cur === '#' || cur === '',
      `got "${cur}", want "#" or ""`);
  } else {
    assert(`[${s.label}] empty hash stays empty`,
      cur === '',
      `got "${cur}", want ""`);
  }
}

// ---------------------------------------------------------------------------
// 5. Bonus: confirm that an explicit applyFilters(defaults) call (as if a
//    user clicked "reset" on a freshly-loaded empty-hash page) also yields
//    182 markers. This is the same predicate from a different code path.
// ---------------------------------------------------------------------------
{
  const env = buildSandbox({ kind: 'empty' });
  vm.createContext(env.sandbox);
  vm.runInContext(SCRIPT_BUNDLE, env.sandbox, { filename: 'boot:reset-after-empty' });
  // Force a re-application of defaults (FilterState.replace fires applyFilters
  // even when state is value-equal — see the comment at FilterState.replace).
  env.sandbox.FilterState.replace({});
  const cluster = env.getCluster();
  assert('reset-on-empty: cluster still has 182',
    cluster && cluster._layers.length === TARGET_COUNT,
    `got ${cluster && cluster._layers.length}, want ${TARGET_COUNT}`);
}

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------
rmSync(td, { recursive: true, force: true });
console.log();
if (failures){
  console.error(`verify_empty_hash_full_population: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log(`verify_empty_hash_full_population: empty/missing hash → ${TARGET_COUNT}/${TARGET_COUNT} ✓`);
