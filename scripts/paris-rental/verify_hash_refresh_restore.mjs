#!/usr/bin/env node
/**
 * AC 3 verifier — "URL hash 새로고침 시 모든 필터 상태 정확히 복원".
 *
 * Goes beyond the per-axis round-trip and hashchange test in
 * verify_hash_roundtrip.mjs by emulating a TRUE page refresh: for each sample
 * hash, we (1) render a fresh paris-realestate.html, (2) build a clean DOM/L
 * sandbox, (3) PRE-SET `location.hash` to the sample BEFORE evaluating the
 * inline script bundle, (4) evaluate the bundle, then (5) assert that on the
 * first paint the FilterState, DOM controls (number inputs + chip checkboxes
 * + move-in toggle), URL hash, and cluster's visible markers all reflect the
 * sample hash with no lossy transformation.
 *
 * The key distinction from the hashchange test:
 *   - hashchange test:   script runs with empty hash → user later sets hash → fire hashchange
 *   - refresh emulation: script runs with hash ALREADY in location → restoreFromHash on init
 *
 * Both code paths converge on the same restoreFromHash() implementation, but
 * exercising the init path independently catches ordering bugs (e.g. if
 * applyFilters were ever subscribed AFTER restoreFromHash ran, refreshes would
 * silently fail to filter the cluster on first paint even though hashchange
 * worked fine).
 *
 * Exit criterion exercised: the Seed's `url_hash_round_trip` —
 *   "임의 필터 조합 → URL hash → 새로고침 → 동일 상태 복원 (5개 샘플 hash 무손실 round-trip)".
 *
 * Run from repo root:  node scripts/paris-rental/verify_hash_refresh_restore.mjs
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

// 8 fixture listings spanning the full chip vocabulary on every axis so each
// sample-hash refresh produces a non-trivial filtered cluster size we can
// independently compute and check against.
const FIXTURE = [
  { namespaced_id: 'fz-bbs2:1', post_id: '1', source: 'francezone-bbs2',
    title: 'T2 14e meublé', url: 'https://example.com/1', verdict: 'pass',
    lat: 48.83, lng: 2.32, location_text: '14e',
    price_eur: 1200, area_m2: 35, move_in: '2026-06-01',
    rooms: 'T2', meuble: 'meuble', zip_or_arr: '75014',
    metro_lines: ['M6', 'M13'] },
  { namespaced_id: 'pap:2', post_id: '2', source: 'pap',
    title: 'T3 11e non meublé', url: 'https://example.com/2', verdict: 'pass',
    lat: 48.85, lng: 2.37, location_text: '11e',
    price_eur: 1800, area_m2: 55, move_in: '2026-09-01',
    rooms: 'T3', meuble: 'non', zip_or_arr: '75011',
    metro_lines: ['M9'] },
  { namespaced_id: 'fz-bbs3:3', post_id: '3', source: 'francezone-bbs3',
    title: 'T1 92 unknown meuble', url: 'https://example.com/3', verdict: 'ambiguous',
    lat: 48.88, lng: 2.24, location_text: 'Boulogne',
    price_eur: 900, area_m2: 22, move_in: null,
    rooms: 'T1', meuble: 'unknown', zip_or_arr: '92100',
    metro_lines: ['M10'] },
  { namespaced_id: 'fz-bbs2:4', post_id: '4', source: 'francezone-bbs2',
    title: 'T4+ 1e meublé old', url: 'https://example.com/4', verdict: 'pass',
    lat: 48.86, lng: 2.34, location_text: '1e',
    price_eur: 2400, area_m2: 80, move_in: '2025-09-01',
    rooms: 'T4+', meuble: 'meuble', zip_or_arr: '75001',
    metro_lines: ['M1', 'M14'] },
  { namespaced_id: 'pap:5', post_id: '5', source: 'pap',
    title: 'T2 14 RER A', url: 'https://example.com/5', verdict: 'pass',
    lat: 48.84, lng: 2.33, location_text: '14e',
    price_eur: 1100, area_m2: 32, move_in: 'flexible',
    rooms: 'T2', meuble: 'meuble', zip_or_arr: '75014',
    metro_lines: ['RER-A', 'M14'] },
  { namespaced_id: 'fz-bbs3:6', post_id: '6', source: 'francezone-bbs3',
    title: 'T3 15 meublé', url: 'https://example.com/6', verdict: 'pass',
    lat: 48.84, lng: 2.30, location_text: '15e',
    price_eur: 1500, area_m2: 48, move_in: '2026-07-15',
    rooms: 'T3', meuble: 'meuble', zip_or_arr: '75015',
    metro_lines: ['M12'] },
  { namespaced_id: 'pap:7', post_id: '7', source: 'pap',
    title: 'T1 unknown rooms', url: 'https://example.com/7', verdict: 'ambiguous',
    lat: 48.87, lng: 2.36, location_text: '10e',
    price_eur: 850, area_m2: 18, move_in: '2026-08-01',
    rooms: 'unknown', meuble: 'unknown', zip_or_arr: '75010',
    metro_lines: ['M4', 'M5'] },
  { namespaced_id: 'fz-bbs2:8', post_id: '8', source: 'francezone-bbs2',
    title: 'T2 11 meuble', url: 'https://example.com/8', verdict: 'pass',
    lat: 48.86, lng: 2.38, location_text: '11e',
    price_eur: 1000, area_m2: 30, move_in: '2026-06-15',
    rooms: 'T2', meuble: 'meuble', zip_or_arr: '75011',
    metro_lines: ['M9', 'M2'] },
];

// --------------------------------------------------------------------------
// Render the HTML once, extract the inline scripts (we re-evaluate the same
// script bundle in a fresh vm context per sample so each refresh is hermetic).
// --------------------------------------------------------------------------
const td = mkdtempSync(path.join(tmpdir(), 'parishash-refresh-'));
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
if (scriptBlocks.length === 0) {
  console.error('FAIL: no inline <script> blocks in rendered HTML');
  rmSync(td, { recursive: true, force: true });
  process.exit(1);
}
const SCRIPT_BUNDLE = scriptBlocks.join(';\n;') + `
;try { globalThis.FilterState = FilterState; } catch(e){}
;try { globalThis.applyFilters = applyFilters; } catch(e){}
`;

// --------------------------------------------------------------------------
// DOM + Leaflet shim factory — builds a fresh sandbox per refresh emulation.
// --------------------------------------------------------------------------
function buildSandbox(initialHash){
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
  // Metro line chips (whose UI ships in a sibling AC). Adding them here is
  // idempotent — if the runtime doesn't query for them, they're inert; if it
  // does, the refresh test exercises the line-axis restore path too.
  chips('filter-line', ['M1', 'M2', 'M4', 'M5', 'M6', 'M9', 'M10', 'M12', 'M13', 'M14', 'RER-A', 'RER-B', 'T3a']);
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
  // Pre-set the URL hash BEFORE the script runs — this is the whole point of
  // emulating a true refresh. The script's `restoreFromHash()` call at init
  // time must observe this value and produce filtered output on first paint.
  const location = { hash: initialHash || '', pathname: '/paris-realestate.html', search: '' };
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

// --------------------------------------------------------------------------
// Reference predicate — a JS reimplementation of passesFilter() used to
// independently compute the expected visible-marker count per sample, so we
// don't just trust the runtime against itself.
// --------------------------------------------------------------------------
function arrBucketRef(zip){
  if (zip == null) return 'unknown';
  const s = String(zip).trim();
  if (s === '') return 'unknown';
  const m75 = /^75(\d{3})$/.exec(s);
  if (m75){
    const n = parseInt(m75[1], 10);
    if (n >= 1 && n <= 20) return String(n);
    return 'unknown';
  }
  if (/^9[234]\d{3}$/.test(s)) return s.slice(0, 2);
  return 'unknown';
}
function moveInOkRef(m){
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
function inRangeRef(v, lo, hi){
  if (v == null) return true;
  if (lo != null && v < lo) return false;
  if (hi != null && v > hi) return false;
  return true;
}
function inSetRef(v, sel){
  if (!sel || sel.length === 0) return true;
  const b = (v == null || v === '') ? 'unknown' : v;
  return sel.includes(b);
}
function passesLocationRef(d, state){
  // Mirrors the runtime's passesLocation(): arr ∪ metro-line OR semantics
  // (the location axis combines arr-multi-select OR metro-line-multi-select).
  // When BOTH halves are empty selections, location is unfiltered (passes).
  // When only one half has a selection, that half decides. When both have
  // selections, a listing passes if EITHER half matches.
  const arrSel  = state.arrSelected || [];
  const lineSel = state.metroLinesSelected || [];
  if (arrSel.length === 0 && lineSel.length === 0) return true;
  const arrHit  = arrSel.length  > 0 && inSetRef(arrBucketRef(d.zip_or_arr), arrSel);
  const linesOf = Array.isArray(d.metro_lines) ? d.metro_lines : [];
  const lineHit = lineSel.length > 0 && linesOf.some(l => lineSel.includes(l));
  if (arrSel.length > 0 && lineSel.length > 0) return arrHit || lineHit;
  if (arrSel.length > 0) return arrHit;
  return lineHit;
}

function expectedVisibleCount(state, listings){
  // Reference predicate mirrors the runtime's passesFilter() semantics
  // exactly (non-location axes ANDed; location axis OR-combined inside
  // passesLocationRef). We compute the expected count independently of the
  // runtime so a refresh assertion that says "cluster.addLayers got N"
  // is checked against an oracle, not against the runtime checking itself.
  let n = 0;
  for (const d of listings){
    if (!inRangeRef(d.price_eur, state.priceMin, state.priceMax)) continue;
    if (!inRangeRef(d.area_m2,   state.areaMin,  state.areaMax))  continue;
    if (!inSetRef(d.rooms,  state.roomsSelected))  continue;
    if (!inSetRef(d.meuble, state.meubleSelected)) continue;
    if (state.moveInAfter202606 && !moveInOkRef(d.move_in)) continue;
    if (!inSetRef(d.source, state.sourcesSelected)) continue;
    if (!passesLocationRef(d, state)) continue;
    n++;
  }
  return n;
}

// --------------------------------------------------------------------------
// Five sample hashes matching the Seed exit criterion. Each is hand-tuned so
// the expected filtered-cluster count is deterministic for our 8 fixtures.
// --------------------------------------------------------------------------
const SAMPLES = [
  {
    label: 'price+rooms (Seed example)',
    hash:  '#price=400-1500&rooms=T2,T3',
    expected: {
      priceMin: 400, priceMax: 1500,
      areaMin: null, areaMax: null,
      roomsSelected: ['T2', 'T3'],
      meubleSelected: [],
      moveInAfter202606: false,
      sourcesSelected: [], arrSelected: [], metroLinesSelected: [],
    },
  },
  {
    label: 'area+meuble+movein',
    hash:  '#area=20-50&meuble=meuble&movein=1',
    expected: {
      priceMin: null, priceMax: null,
      areaMin: 20, areaMax: 50,
      roomsSelected: [],
      meubleSelected: ['meuble'],
      moveInAfter202606: true,
      sourcesSelected: [], arrSelected: [], metroLinesSelected: [],
    },
  },
  {
    label: 'rooms incl T4+ (% encoded) + sources',
    hash:  '#rooms=T1,T2,T3,T4%2B&sources=pap',
    expected: {
      priceMin: null, priceMax: null,
      areaMin: null, areaMax: null,
      roomsSelected: ['T1', 'T2', 'T3', 'T4+'],
      meubleSelected: [],
      moveInAfter202606: false,
      sourcesSelected: ['pap'],
      arrSelected: [], metroLinesSelected: [],
    },
  },
  {
    label: 'arr + line',
    hash:  '#arr=14,15&line=M14,RER-A',
    expected: {
      priceMin: null, priceMax: null,
      areaMin: null, areaMax: null,
      roomsSelected: [], meubleSelected: [],
      moveInAfter202606: false,
      sourcesSelected: [],
      arrSelected: ['14', '15'],
      metroLinesSelected: ['M14', 'RER-A'],
    },
  },
  {
    label: 'all 7 axes simultaneously',
    hash:  '#price=750-1500&area=30-50&rooms=T2,T3&meuble=meuble&movein=1&sources=francezone-bbs2,francezone-bbs3,pap&arr=11,14,15&line=M9,M12,M14',
    expected: {
      priceMin: 750, priceMax: 1500,
      areaMin: 30, areaMax: 50,
      roomsSelected: ['T2', 'T3'],
      meubleSelected: ['meuble'],
      moveInAfter202606: true,
      sourcesSelected: ['francezone-bbs2', 'francezone-bbs3', 'pap'],
      arrSelected: ['11', '14', '15'],
      metroLinesSelected: ['M9', 'M12', 'M14'],
    },
  },
];

// --------------------------------------------------------------------------
// Run each sample as an independent refresh emulation.
// --------------------------------------------------------------------------
let failures = 0;
function assert(label, cond, detail){
  const status = cond ? 'OK' : 'FAIL';
  console.log(`[${status}] ${label}: ${detail}`);
  if (!cond) failures++;
}
function eqArr(a, b){
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = a.slice().sort(), sb = b.slice().sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

for (const sample of SAMPLES){
  const env = buildSandbox(sample.hash);
  vm.createContext(env.sandbox);
  try {
    vm.runInContext(SCRIPT_BUNDLE, env.sandbox, { filename: `refresh:${sample.label}` });
  } catch (e) {
    assert(`refresh boot: ${sample.label}`, false, `script threw: ${e.message}`);
    continue;
  }

  const state = env.sandbox.FilterState ? env.sandbox.FilterState.get() : null;
  if (!state){
    assert(`refresh state read: ${sample.label}`, false, 'FilterState not exposed');
    continue;
  }

  // 1. State matches expected (every dimension lossless).
  const exp = sample.expected;
  assert(`[${sample.label}] state.priceMin`,
    state.priceMin === exp.priceMin, `got ${state.priceMin}, want ${exp.priceMin}`);
  assert(`[${sample.label}] state.priceMax`,
    state.priceMax === exp.priceMax, `got ${state.priceMax}, want ${exp.priceMax}`);
  assert(`[${sample.label}] state.areaMin`,
    state.areaMin === exp.areaMin, `got ${state.areaMin}, want ${exp.areaMin}`);
  assert(`[${sample.label}] state.areaMax`,
    state.areaMax === exp.areaMax, `got ${state.areaMax}, want ${exp.areaMax}`);
  assert(`[${sample.label}] state.rooms`,
    eqArr(state.roomsSelected, exp.roomsSelected),
    `got ${JSON.stringify(state.roomsSelected)}, want ${JSON.stringify(exp.roomsSelected)}`);
  assert(`[${sample.label}] state.meuble`,
    eqArr(state.meubleSelected, exp.meubleSelected),
    `got ${JSON.stringify(state.meubleSelected)}, want ${JSON.stringify(exp.meubleSelected)}`);
  assert(`[${sample.label}] state.movein`,
    state.moveInAfter202606 === exp.moveInAfter202606,
    `got ${state.moveInAfter202606}, want ${exp.moveInAfter202606}`);
  assert(`[${sample.label}] state.sources`,
    eqArr(state.sourcesSelected, exp.sourcesSelected),
    `got ${JSON.stringify(state.sourcesSelected)}, want ${JSON.stringify(exp.sourcesSelected)}`);
  assert(`[${sample.label}] state.arr`,
    eqArr(state.arrSelected, exp.arrSelected),
    `got ${JSON.stringify(state.arrSelected)}, want ${JSON.stringify(exp.arrSelected)}`);
  assert(`[${sample.label}] state.line`,
    eqArr(state.metroLinesSelected, exp.metroLinesSelected),
    `got ${JSON.stringify(state.metroLinesSelected)}, want ${JSON.stringify(exp.metroLinesSelected)}`);

  // 2. DOM controls match the restored state — number inputs populated,
  // chips checked, move-in toggle reflects the boolean.
  const valOf = (id) => {
    const el = env.idIndex.get(id);
    return el ? el.value : null;
  };
  const expVal = (v) => v == null ? '' : String(v);
  assert(`[${sample.label}] dom.priceMin`,
    valOf('filter-price-min') === expVal(exp.priceMin),
    `got "${valOf('filter-price-min')}", want "${expVal(exp.priceMin)}"`);
  assert(`[${sample.label}] dom.priceMax`,
    valOf('filter-price-max') === expVal(exp.priceMax),
    `got "${valOf('filter-price-max')}", want "${expVal(exp.priceMax)}"`);
  assert(`[${sample.label}] dom.areaMin`,
    valOf('filter-area-min') === expVal(exp.areaMin),
    `got "${valOf('filter-area-min')}", want "${expVal(exp.areaMin)}"`);
  assert(`[${sample.label}] dom.areaMax`,
    valOf('filter-area-max') === expVal(exp.areaMax),
    `got "${valOf('filter-area-max')}", want "${expVal(exp.areaMax)}"`);
  const moveinEl = env.idIndex.get('filter-movein');
  assert(`[${sample.label}] dom.movein`,
    !!moveinEl && moveinEl.checked === exp.moveInAfter202606,
    `got ${moveinEl && moveinEl.checked}, want ${exp.moveInAfter202606}`);
  function chipsChecked(cls){
    const list = env.classIndex.get(cls) || [];
    return list.filter(n => n.checked).map(n => n.attrs.value);
  }
  assert(`[${sample.label}] dom.rooms chips`,
    eqArr(chipsChecked('filter-rooms'), exp.roomsSelected),
    `got ${JSON.stringify(chipsChecked('filter-rooms'))}, want ${JSON.stringify(exp.roomsSelected)}`);
  assert(`[${sample.label}] dom.meuble chips`,
    eqArr(chipsChecked('filter-meuble'), exp.meubleSelected),
    `got ${JSON.stringify(chipsChecked('filter-meuble'))}, want ${JSON.stringify(exp.meubleSelected)}`);
  assert(`[${sample.label}] dom.sources chips`,
    eqArr(chipsChecked('filter-sources'), exp.sourcesSelected),
    `got ${JSON.stringify(chipsChecked('filter-sources'))}, want ${JSON.stringify(exp.sourcesSelected)}`);
  assert(`[${sample.label}] dom.arr chips`,
    eqArr(chipsChecked('filter-arr'), exp.arrSelected),
    `got ${JSON.stringify(chipsChecked('filter-arr'))}, want ${JSON.stringify(exp.arrSelected)}`);
  assert(`[${sample.label}] dom.line chips`,
    eqArr(chipsChecked('filter-line'), exp.metroLinesSelected),
    `got ${JSON.stringify(chipsChecked('filter-line'))}, want ${JSON.stringify(exp.metroLinesSelected)}`);

  // 3. URL hash unchanged after restore (history.replaceState is idempotent
  // when current === target). Lossless serialize round-trip.
  const reSerialized = env.sandbox.FilterHash.serialize(state);
  const reParsed = env.sandbox.FilterHash.parse('#' + reSerialized);
  assert(`[${sample.label}] serialize→parse idempotent`,
    JSON.stringify({
      priceMin: reParsed.priceMin, priceMax: reParsed.priceMax,
      areaMin: reParsed.areaMin,   areaMax: reParsed.areaMax,
      roomsSelected: reParsed.roomsSelected.slice().sort(),
      meubleSelected: reParsed.meubleSelected.slice().sort(),
      moveInAfter202606: reParsed.moveInAfter202606,
      sourcesSelected: reParsed.sourcesSelected.slice().sort(),
      arrSelected: reParsed.arrSelected.slice().sort(),
      metroLinesSelected: reParsed.metroLinesSelected.slice().sort(),
    }) === JSON.stringify({
      priceMin: exp.priceMin, priceMax: exp.priceMax,
      areaMin: exp.areaMin,   areaMax: exp.areaMax,
      roomsSelected: exp.roomsSelected.slice().sort(),
      meubleSelected: exp.meubleSelected.slice().sort(),
      moveInAfter202606: exp.moveInAfter202606,
      sourcesSelected: exp.sourcesSelected.slice().sort(),
      arrSelected: exp.arrSelected.slice().sort(),
      metroLinesSelected: exp.metroLinesSelected.slice().sort(),
    }),
    `re-serialized hash="${reSerialized}"`);

  // 4. Cluster received filtered markers on first paint — count matches the
  // independent reference predicate.
  const wantCount = expectedVisibleCount(exp, FIXTURE);
  const lastAdd = env.clusterAddLayersCalls.at(-1);
  assert(`[${sample.label}] cluster filtered on init`,
    lastAdd === wantCount,
    `cluster.addLayers got ${lastAdd}, expected ${wantCount} (of ${FIXTURE.length})`);
}

// --------------------------------------------------------------------------
// Bonus: empty-hash refresh leaves state at defaults and ALL markers visible.
// --------------------------------------------------------------------------
{
  const env = buildSandbox('');
  vm.createContext(env.sandbox);
  vm.runInContext(SCRIPT_BUNDLE, env.sandbox, { filename: 'refresh:empty' });
  const s = env.sandbox.FilterState.get();
  assert('empty-hash refresh: state at defaults',
    s.priceMin === null && s.priceMax === null &&
    s.areaMin === null && s.areaMax === null &&
    s.roomsSelected.length === 0 && s.meubleSelected.length === 0 &&
    s.moveInAfter202606 === false &&
    s.sourcesSelected.length === 0 && s.arrSelected.length === 0 &&
    s.metroLinesSelected.length === 0,
    JSON.stringify(s));
  const lastAdd = env.clusterAddLayersCalls.at(-1);
  assert('empty-hash refresh: all 8 markers visible',
    lastAdd === FIXTURE.length,
    `cluster.addLayers got ${lastAdd}, expected ${FIXTURE.length}`);
}

// --------------------------------------------------------------------------
// Bonus: deep-link hash refresh ('#francezone-bbs2:1') leaves state at
// defaults (filter system ignores deep-link hashes; openHash() handles them).
// --------------------------------------------------------------------------
{
  const env = buildSandbox('#francezone-bbs2:1');
  vm.createContext(env.sandbox);
  vm.runInContext(SCRIPT_BUNDLE, env.sandbox, { filename: 'refresh:deeplink' });
  const s = env.sandbox.FilterState.get();
  assert('deep-link refresh: state at defaults (filters untouched)',
    s.priceMin === null && s.roomsSelected.length === 0 &&
    s.moveInAfter202606 === false,
    JSON.stringify(s));
  // Deep-link hash MUST survive the script init (writeHashFromState should
  // not clobber it with an empty filter hash).
  assert('deep-link refresh: location.hash preserved',
    env.location.hash === '#francezone-bbs2:1',
    `got "${env.location.hash}"`);
}

// --------------------------------------------------------------------------
// Cleanup + summary
// --------------------------------------------------------------------------
rmSync(td, { recursive: true, force: true });
console.log();
if (failures){
  console.error(`verify_hash_refresh_restore: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('verify_hash_refresh_restore: 5-sample refresh restore ✓');
