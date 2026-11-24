/* Go Travel - the game page. Trips are recorded by the app (TrackService) and counted here by the engine (engine.js). */
(function () {
  'use strict';
  const SITE = 'https://tomvinograd.github.io/glimmer-isle-play/go-travel/';
  const BUILD = window.GT_BUILD || 0;
  const TILEJSON = 'https://tiles.openfreemap.org/planet';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const opened = Date.now();

  // ---------- the phone (native plugin) or a stand-in in a plain browser ----------
  const Cap = window.Capacitor;
  const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const GT = native ? Cap.registerPlugin('GoTravel') : (window.GT_FAKE || makeFake());
  const AppP = native ? Cap.registerPlugin('App') : null;

  function makeFake() {
    // Browser stand-in: same calls as the app; tests push fixes with __gt.feed([...]).
    // kept in sessionStorage so a reload acts like the real app, where the recording lives outside the page
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem('gt.fake') || 'null'); } catch (e) { kept = null; }
    const L = Object.assign({ lines: [], running: false, startedAt: 0, perm: { location: true, activity: true, notifications: true, battery: false, gpsOn: true } }, kept || {}, { listeners: {} });
    const keep = () => { try { sessionStorage.setItem('gt.fake', JSON.stringify({ lines: L.lines, running: L.running, startedAt: L.startedAt, perm: L.perm })); } catch (e) { /* ignore */ } };
    window.addEventListener('pagehide', keep);
    const emit = (n, o) => (L.listeners[n] || []).forEach((f) => f(o));
    const f = {
      _L: L,
      ready: async () => {}, info: async () => ({ versionName: 'browser', versionCode: 0, web: BUILD, stepSensor: true, model: 'browser' }),
      perms: async () => ({ ...L.perm }), ask: async (o) => { L.perm[o.which] = true; return { ...L.perm }; },
      askBattery: async () => { L.perm.battery = true; }, openSettings: async () => {},
      start: async () => { if (!L.running) { L.running = true; L.startedAt = Date.now(); } keep(); return { running: true, startedAt: L.startedAt }; },
      stop: async () => { L.running = false; const r = { running: false, startedAt: L.startedAt }; L.startedAt = 0; keep(); return r; },
      status: async () => ({ running: L.running, startedAt: L.startedAt, fixes: L.lines.length }),
      read: async (o) => ({ lines: L.lines.slice(o.from || 0).map((x) => JSON.stringify(x)).join('\n'), count: L.lines.length }),
      clear: async () => { L.lines = []; keep(); },
      watch: async () => {},
      checkUpdate: async () => ({ state: 'none', v: BUILD }), applyUpdate: async () => {},
      addListener: (n, fn) => { (L.listeners[n] = L.listeners[n] || []).push(fn); return { remove() {} }; },
      feed: (fixes, live) => { for (const x of fixes) { if (!live && L.running) L.lines.push(x); emit('fix', live ? { ...x, live: true } : x); } keep(); },
    };
    return f;
  }

  // ---------- saved state ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const S = Object.assign({ v: 1, lang: (navigator.language || '').startsWith('he') ? 'he' : 'en', name: '', seen: 0, pts: 0, newM: 0, m: 0, steps: 0, natM: 0, trips: [] }, store.get('gt.s', {}));
  let cells = store.get('gt.cells', []);       // painted cells of finished trips
  let lines = store.get('gt.lines', []);       // painted lines of finished trips
  let cur = store.get('gt.cur', null);         // the trip being recorded
  let pend = store.get('gt.pend', []);         // finished trips still being counted (offline when they ended)
  const painted = new Set(cells);
  for (const t of [cur, ...pend]) if (t) for (const c of t.cells) painted.add(c);
  const saveS = () => store.set('gt.s', S);
  const saveCur = () => { store.set('gt.cur', cur); store.set('gt.pend', pend); };

  // ---------- words ----------
  function T(k, vars) {
    let s = (GT_WORDS[S.lang] || GT_WORDS.en)[k];
    if (s == null) s = GT_WORDS.en[k] != null ? GT_WORDS.en[k] : k;
    if (vars) for (const v in vars) s = s.split('{' + v + '}').join(vars[v]);
    return s;
  }
  const nf = (n, d = 0) => Number(n).toLocaleString(S.lang === 'he' ? 'he-IL' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtM = (m) => (m >= 1000 ? T('km_s', { n: nf(m / 1000, 2) }) : T('m_s', { n: nf(Math.round(m)) }));
  const fmtT = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const fmtDate = (t) => new Date(t).toLocaleString(S.lang === 'he' ? 'he-IL' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function applyLang() {
    document.documentElement.lang = S.lang;
    document.documentElement.dir = S.lang === 'he' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-t]').forEach((e) => { e.textContent = T(e.dataset.t); });
    $('#btnMe').setAttribute('aria-label', T('centerMe'));
  }

  // ---------- levels ----------
  const lvlOf = (p) => Math.floor(Math.sqrt(p / 200)) + 1;
  const lvlAt = (l) => 200 * (l - 1) * (l - 1);
  function totalPts() { let p = S.pts; for (const t of [cur, ...pend]) if (t) p += Math.round(t.pts); return p; }

  // ---------- engine ----------
  let tileUrl = null;
  async function getTileUrl() {
    if (tileUrl) return tileUrl;
    const k = store.get('gt.tj', null);
    if (k && Date.now() - k.at < 86400000) return (tileUrl = k.url);
    try {
      const j = await (await fetch(TILEJSON)).json();
      tileUrl = j.tiles[0];
      store.set('gt.tj', { url: tileUrl, at: Date.now() });
    } catch (e) { if (k) return (tileUrl = k.url); throw e; }
    return tileUrl;
  }
  async function fetchTile(z, x, y) {
    const url = (await getTileUrl()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
    let cache = null;
    try { cache = await caches.open('gt-tiles'); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch (e) { cache = null; }
    const r = await fetch(url);
    if (!r.ok) throw new Error('tile ' + r.status);
    if (cache) try { await cache.put(url, r.clone()); } catch (e) { /* ignore */ }
    return r.arrayBuffer();
  }
  const eng = GTEngine.create({ fetchTile });

  // ---------- map ----------
  let map = null, marker = null, follow = true, lastPos = null, mapReady = false;
  function nameExpr() {
    return S.lang === 'he' ? ['coalesce', ['get', 'name:he'], ['get', 'name']] : ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
  }
  function mapStyle() {
    const w = (a, b) => ['interpolate', ['exponential', 1.6], ['zoom'], 12, a, 18, b];
    const road = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 1, ['secondary', 'tertiary'], 0.8, ['minor', 'service'], 0.55, 0.4];
    const rw = (a, b) => w(['*', road, a], ['*', road, b]); // zoom must stay the top-level input
    const isPath = ['match', ['get', 'class'], ['path', 'track'], true, false];
    const nm = nameExpr();
    return {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: { omt: { type: 'vector', url: TILEJSON } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#F3EAD7' } },
        { id: 'res', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood']]], paint: { 'fill-color': '#EFE2C9' } },
        { id: 'farm', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['farmland', 'orchard', 'vineyard', 'allotments']]], paint: { 'fill-color': '#E6E9B8' } },
        { id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland']]], paint: { 'fill-color': '#D3EDB0' } },
        { id: 'sand', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'sand'], paint: { 'fill-color': '#F7E6B5' } },
        { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': '#9ED47F' } },
        { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#BFE69A', 'fill-opacity': 0.6 } },
        { id: 'park-edge', type: 'line', source: 'omt', 'source-layer': 'park', filter: ['in', ['get', 'class'], ['literal', ['nature_reserve', 'national_park', 'protected_area']]], paint: { 'line-color': '#4E9F3D', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.7 } },
        { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#7FCDEE' } },
        { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': '#7FCDEE', 'line-width': w(1, 5) } },
        { id: 'bld-shadow', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 15, paint: { 'fill-color': '#D2BB97', 'fill-translate': [2, 2] } },
        { id: 'bld', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 15, paint: { 'fill-color': '#F2E2C8', 'fill-outline-color': '#CDB48D' } },
        { id: 'path', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: isPath, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#B88A5A', 'line-width': w(0.8, 3.5), 'line-dasharray': [2, 1.5] } },
        { id: 'road-case', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['all', ['!', isPath], ['!=', ['get', 'class'], 'rail'], ['!=', ['get', 'class'], 'transit']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#D6C19C', 'line-width': rw(2.5, 26) } },
        { id: 'road', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['all', ['!', isPath], ['!=', ['get', 'class'], 'rail'], ['!=', ['get', 'class'], 'transit']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#FFD27A', 'primary', '#FFE7AE', '#FFFFFF'], 'line-width': rw(1.5, 21) } },
        { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': '#A99A88', 'line-width': w(1, 3), 'line-dasharray': [3, 3] } },
        { id: 'road-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14, layout: { 'symbol-placement': 'line', 'text-field': nm, 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-max-angle': 30 }, paint: { 'text-color': '#6B5640', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.6 } },
        { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name', layout: { 'text-field': nm, 'text-font': ['Noto Sans Italic'], 'text-size': 13 }, paint: { 'text-color': '#2F7FA8', 'text-halo-color': '#E6F6FD', 'text-halo-width': 1.5 } },
        { id: 'park-name', type: 'symbol', source: 'omt', 'source-layer': 'park', minzoom: 12, layout: { 'text-field': nm, 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'symbol-placement': 'point' }, paint: { 'text-color': '#2F6E22', 'text-halo-color': '#F3FBEA', 'text-halo-width': 1.6 } },
        { id: 'place', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'neighbourhood']]], layout: { 'text-field': nm, 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 16, 13], 'text-transform': 'none' }, paint: { 'text-color': '#4A3926', 'text-halo-color': '#FFF8EC', 'text-halo-width': 2 } },
      ],
    };
  }
  const EMPTY = { type: 'FeatureCollection', features: [] };
  function initMap() {
    if (!window.maplibregl) return;
    try {
      maplibregl.setRTLTextPlugin(new URL('lib/mapbox-gl-rtl-text.js', location.href).href, true);
    } catch (e) { /* already set */ }
    const start = lastPos ? [lastPos.lo, lastPos.la] : (S.at || [34.7818, 32.0853]);
    map = new maplibregl.Map({ container: 'map', style: mapStyle(), center: start, zoom: 16, attributionControl: { compact: true }, pitchWithRotate: false, dragRotate: false, maxZoom: 19, minZoom: 7 });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => {
      map.addSource('painted', { type: 'geojson', data: EMPTY });
      map.addSource('cur', { type: 'geojson', data: EMPTY });
      map.addSource('raw', { type: 'geojson', data: EMPTY });
      map.addSource('focus', { type: 'geojson', data: EMPTY });
      const lw = (a, b) => ['interpolate', ['exponential', 1.6], ['zoom'], 12, a, 18, b];
      map.addLayer({ id: 'raw', type: 'line', source: 'raw', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7A6A58', 'line-width': 2, 'line-opacity': 0.5, 'line-dasharray': [1, 2] } }, 'road-name');
      map.addLayer({ id: 'painted-case', type: 'line', source: 'painted', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#FFFFFF', 'line-width': lw(4, 16) } }, 'road-name');
      map.addLayer({ id: 'painted', type: 'line', source: 'painted', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1E7BFF', 'line-width': lw(2.5, 11) } }, 'road-name');
      map.addLayer({ id: 'cur-glow', type: 'line', source: 'cur', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7FD3FF', 'line-width': lw(7, 24), 'line-blur': 4, 'line-opacity': 0.8 } }, 'road-name');
      map.addLayer({ id: 'cur', type: 'line', source: 'cur', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1E7BFF', 'line-width': lw(3, 12) } }, 'road-name');
      map.addLayer({ id: 'focus', type: 'line', source: 'focus', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#FF8A1F', 'line-width': lw(3, 10) } }, 'road-name');
      mapReady = true;
      drawPainted(); drawCur();
    });
    map.on('dragstart', (e) => { if (e.originalEvent) setFollow(false); });
    const el = document.createElement('div');
    el.className = 'me';
    marker = new maplibregl.Marker({ element: el }).setLngLat(start);
    if (lastPos || S.at) marker.addTo(map);
  }
  const segFeature = (segs) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segs.filter((s) => s.length > 1) } });
  function drawPainted() {
    if (!mapReady) return;
    const all = lines.concat(...pend.map((t) => t.segs));
    map.getSource('painted').setData({ type: 'FeatureCollection', features: [segFeature(all)] });
  }
  function drawCur() {
    if (!mapReady) return;
    map.getSource('cur').setData(cur ? { type: 'FeatureCollection', features: [segFeature(cur.segs)] } : EMPTY);
    const raw = [];
    let part = [];
    for (const p of cur ? cur.raw : []) { if (!p) { if (part.length > 1) raw.push(part); part = []; } else part.push(p); }
    if (part.length > 1) raw.push(part);
    map.getSource('raw').setData(raw.length ? { type: 'FeatureCollection', features: [segFeature(raw)] } : EMPTY);
  }
  function setFollow(on) {
    follow = on;
    $('#btnMe').classList.toggle('on', on);
    if (on && lastPos && map) map.easeTo({ center: [lastPos.lo, lastPos.la], duration: 500 });
  }
  function moveMe(f) {
    lastPos = f;
    S.at = [Math.round(f.lo * 1e4) / 1e4, Math.round(f.la * 1e4) / 1e4];
    if (!map) return;
    marker.setLngLat([f.lo, f.la]);
    if (!marker._map) marker.addTo(map);
    marker.getElement().classList.toggle('weak', !(f.ac <= 25));
    if (follow) map.easeTo({ center: [f.lo, f.la], duration: 700 });
  }

  // ---------- trip recording ----------
  let pumping = false, offline = false, notes = {};
  function note(kind, on, ms) {
    if (on) notes[kind] = ms ? Date.now() + ms : Infinity; else delete notes[kind];
    showNote();
  }
  function showNote() {
    const now = Date.now();
    for (const k in notes) if (notes[k] < now) delete notes[k];
    const order = ['fakeGps', 'outside', 'tooFast', 'offline', 'weakGps'];
    const k = order.find((x) => notes[x]);
    const el = $('#recNote');
    el.hidden = !k || !cur;
    if (k) el.textContent = T(k);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    let changed = false, err = null;
    try {
      // finished trips that were not fully counted come first
      for (const t of pend.slice()) {
        let done = 0;
        for (const ln of t.left) {
          try { await eng.addFix(t, JSON.parse(ln), painted); } catch (e) { if (e instanceof SyntaxError) { done++; continue; } err = e; break; }
          done++;
        }
        if (done) { t.left = t.left.slice(done); changed = true; }
        if (err) break;
        if (!t.left.length) { pend.splice(pend.indexOf(t), 1); finalize(t, true); changed = true; }
      }
      if (cur && !err) {
        const r = await GT.read({ from: cur.idx });
        const ls = r.lines ? r.lines.split('\n').filter(Boolean) : [];
        let done = 0;
        const before = { newM: cur.newM, natM: cur.natM };
        for (const ln of ls) {
          let f;
          try { f = JSON.parse(ln); } catch (e) { done++; continue; }
          let res;
          try { res = await eng.addFix(cur, f, painted); } catch (e) { err = e; break; }
          done++;
          if (res.fast) note('tooFast', true, 20000);
          if (res.mock) note('fakeGps', true);
          note('weakGps', !(f.ac <= 25), 15000);
          if (res.skip === 'outside') note('outside', true, 30000);
        }
        if (done) { cur.idx += done; changed = true; }
        if (cur.newM > before.newM) floatGain(cur.newM - before.newM, cur.natM > before.natM);
        if (cur.natM > 0 && before.natM === 0) toast(T('nature'));
      }
    } catch (e) {
      err = e;
    } finally {
      pumping = false;
    }
    offline = !!err;
    note('offline', offline);
    if (changed) { saveCur(); drawCur(); drawPainted(); }
    updHud(); updDock();
  }

  let gainShown = 0;
  function floatGain(m, nat) {
    if (!lastPos || !map || Date.now() - gainShown < 1500) return;
    gainShown = Date.now();
    const p = map.project([lastPos.lo, lastPos.la]);
    const el = document.createElement('div');
    el.className = 'gain';
    el.textContent = '+' + nf(Math.round(m * (nat ? 2 : 1)));
    el.style.left = (p.x + 16) + 'px'; el.style.top = (p.y - 30) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  async function startTrip() {
    let p = await GT.perms();
    if (!p.location) p = await GT.ask({ which: 'location' });
    if (!p.location) { toast(T('needLoc')); openPerms(); return; }
    if (!p.activity) p = await GT.ask({ which: 'activity' });
    if (!p.notifications) p = await GT.ask({ which: 'notifications' });
    if (!p.gpsOn) { openPerms(); return; }
    await GT.clear();
    const st = await GT.start();
    cur = eng.newTrip(st.startedAt || Date.now());
    cur.id = Date.now().toString(36);
    saveCur();
    notes = {};
    setRecording(true);
    setFollow(true);
    if (!p.battery && !store.get('gt.batAsked', 0)) { store.set('gt.batAsked', 1); openPerms(); }
  }

  function askFinish() {
    sheet(`<h2>${T('finishAsk')}</h2>
      <p>${cur.newM >= 1 ? T('newMetres') + ': <b>' + fmtM(cur.newM) + '</b> · ' + nf(Math.round(cur.pts)) + ' ' + T('points') : T('nothingYet')}</p>
      <div class="acts"><button class="btn plain" data-close>${T('keepGoing')}</button><button class="btn" id="fin">${T('finish')}</button></div>`);
    $('#fin').onclick = () => { closeSheet(); stopTrip(); };
  }

  async function stopTrip() {
    if (!cur) return;
    await GT.stop();
    await pump();
    const r = await GT.read({ from: cur.idx });
    const t = cur;
    t.left = r.lines ? r.lines.split('\n').filter(Boolean) : [];
    t.stopped = Date.now();
    cur = null;
    pend.push(t);
    saveCur();
    await GT.clear();
    setRecording(false);
    await pump();
    if (pend.includes(t)) toast(T('offline'));
  }

  /** A trip is fully counted: add it to the totals and the trips list. */
  function finalize(t, show) {
    const sum = { id: t.id, start: t.start, end: Math.max(t.stopped || 0, t.end || 0), m: Math.round(t.m), newM: Math.round(t.newM), pts: Math.round(t.pts), natM: Math.round(t.natM), steps: t.steps, walkS: Math.round(t.walkS), cycleS: Math.round(t.cycleS), fastM: Math.round(t.fastM), mock: t.mock };
    S.trips.unshift(sum);
    S.pts += sum.pts; S.newM += sum.newM; S.m += sum.m; S.steps += t.steps; S.natM += sum.natM;
    for (const c of t.cells) cells.push(c);
    for (const s of t.segs) if (s.length > 1) lines.push(s);
    store.set('gt.t.' + t.id, { segs: t.segs, raw: t.raw });
    store.set('gt.cells', cells);
    store.set('gt.lines', lines);
    saveS(); saveCur();
    drawPainted();
    if (show) summary(sum);
  }

  function summary(t) {
    const before = S.pts - t.pts, l0 = lvlOf(before), l1 = lvlOf(S.pts);
    sheet(`<div class="hero"><h2>${T('tripDone')}</h2><div class="plus"><span class="star">★</span> +${nf(t.pts)}</div>
      ${l1 > l0 ? `<p><b>${T('level', { n: l1 })}!</b></p>` : ''}</div>
      <div class="list">
        ${row('🖌️', T('newMetres'), '', fmtM(t.newM), 'blue')}
        ${row(t.cycleS > t.walkS ? '🚲' : '🚶', T('distance'), '', fmtM(t.m))}
        ${row('⏱️', T('duration'), '', fmtT((t.end - t.start) / 1000))}
        ${t.steps > 0 ? row('👣', T('steps'), '', nf(t.steps)) : ''}
        ${t.natM ? row('🌲', T('natureBonus'), '', fmtM(t.natM), 'green') : ''}
        ${t.fastM > 50 ? row('🚗', T('fastPart'), '', fmtM(t.fastM)) : ''}
        ${t.mock ? row('⚠️', T('mockTrip'), '', '') : ''}
      </div>
      <div class="acts"><button class="btn blue" data-close>${T('done')}</button></div>`);
  }

  function setRecording(on) {
    document.body.classList.toggle('recording', on);
    $('#idle').hidden = on;
    $('#rec').hidden = !on;
    updDock();
  }

  function updDock() {
    if (cur) {
      $('#recTime').textContent = fmtT((Date.now() - cur.start) / 1000);
      $('#recDist').textContent = nf(cur.m / 1000, 2);
      $('#recNew').textContent = nf(Math.round(cur.newM));
      $('#recPts').textContent = nf(Math.round(cur.pts));
      $('#recSteps').textContent = cur.steps > 0 ? nf(cur.steps) : '–';
      $('#recMode').textContent = cur.cycleS > cur.walkS ? '🚲' : '🚶';
      showNote();
    }
    const day = new Date(); day.setHours(0, 0, 0, 0);
    let today = 0;
    for (const t of S.trips) { if (t.start < day.getTime()) break; today += t.newM; }
    for (const t of [cur, ...pend]) if (t && t.start >= day.getTime()) today += t.newM;
    $('#todayNew').textContent = fmtM(today);
  }

  function updHud() {
    const p = totalPts(), l = lvlOf(p), a = lvlAt(l), b = lvlAt(l + 1);
    $('#lvNum').textContent = l;
    $('#lvBar').style.width = Math.round((p - a) / (b - a) * 100) + '%';
    $('#ptsNum').textContent = nf(p);
  }

  // ---------- sheets, pages, toast ----------
  function sheet(html, opts) {
    const L = $('#layer');
    L.innerHTML = `<div class="scrim"></div><div class="sheet" role="dialog">${opts && opts.noX ? '' : '<button class="x" data-close aria-label="' + T('close') + '">×</button>'}${html}</div>`;
    L.querySelector('.scrim').onclick = () => { if (!(opts && opts.noX)) closeSheet(); };
    L.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheet; });
    return L.querySelector('.sheet');
  }
  function closeSheet() { $('#layer').innerHTML = ''; }
  const sheetOpen = () => !!$('#layer').firstChild;
  let toastT = 0;
  function toast(msg) {
    const el = $('#toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>';
    el.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function row(ic, title, sub, end, tone, attrs) {
    return `<${attrs ? 'button' : 'div'} class="row" ${attrs || ''}><span class="ic ${tone || ''}">${ic}</span><span class="tx"><b>${esc(title)}</b>${sub ? '<small>' + esc(sub) + '</small>' : ''}</span>${end !== '' && end != null ? '<span class="end">' + esc(end) + '</span>' : ''}${attrs ? '<span class="chev">›</span>' : ''}</${attrs ? 'button' : 'div'}>`;
  }

  let pageStack = [];
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    pageStack = [];
    if (name === 'map') { $('#page').hidden = true; if (map) map.resize(); return; }
    openPage(name, true);
  }
  function openPage(name, root) {
    if (!root) pageStack.push(curPage); else pageStack = [];
    curPage = name;
    $('#page').hidden = false;
    $('#pBack').hidden = !pageStack.length;
    const P = PAGES[name]();
    $('#pTitle').textContent = P.title;
    $('#pBody').innerHTML = P.html;
    $('#pBody').scrollTop = 0;
    if (P.wire) P.wire($('#pBody'));
  }
  let curPage = null;
  function pageBack() {
    if (!pageStack.length) { showTab('map'); return; }
    const p = pageStack.pop();
    const keep = pageStack.slice();
    openPage(p, true);
    pageStack = keep;
    $('#pBack').hidden = !pageStack.length;
  }

  const PAGES = {
    trips() {
      const all = [...pend.map((t) => ({ ...t, counting: 1 })), ...S.trips];
      if (!all.length) return { title: T('trips'), html: `<div class="empty"><div class="big">🧭</div><p>${T('noTrips')}</p></div>` };
      return {
        title: T('trips'),
        html: '<div class="list">' + all.map((t) => `<button class="row" data-trip="${t.id}"><span class="ic ${t.cycleS > t.walkS ? 'blue' : ''}">${t.cycleS > t.walkS ? '🚲' : '🚶'}</span>
          <span class="tx"><b>${esc(fmtDate(t.start))}</b><small>${esc(fmtM(t.m))} · ${esc(fmtM(t.newM))} ${esc(T('newPaths'))}</small></span>
          <span class="end pts">${t.counting ? esc(T('counting')) : '★ ' + nf(t.pts)}</span></button>`).join('') + '</div>',
        wire(b) { b.querySelectorAll('[data-trip]').forEach((x) => { x.onclick = () => tripSheet(x.dataset.trip); }); },
      };
    },
    me() {
      const p = totalPts(), l = lvlOf(p);
      return {
        title: T('me'),
        html: `<div class="hero"><div class="logo">${esc(S.name || T('namePh'))}</div><p><b>${T('level', { n: l })}</b> · ${T('toNext', { n: nf(lvlAt(l + 1) - p), m: l + 1 })}</p></div>
          <div class="h2">${T('totals')}</div>
          <div class="bigstats">
            <div><b>★ ${nf(p)}</b><small>${T('ptsTotal')}</small></div>
            <div><b>${fmtM(S.newM + (cur ? cur.newM : 0))}</b><small>${T('newTotal')}</small></div>
            <div><b>${fmtM(S.m)}</b><small>${T('distTotal')}</small></div>
            <div><b>${nf(S.trips.length)}</b><small>${T('tripsTotal')}</small></div>
          </div>
          <div class="h2">&nbsp;</div>
          <div class="list">
            ${row('✏️', T('name'), S.name || T('namePh'), '', '', 'data-p="name"')}
            ${row('🌐', T('language'), S.lang === 'he' ? 'עברית' : 'English', '', '', 'data-p="lang"')}
            ${row('📱', T('phone'), T('phoneInfo'), '', '', 'data-p="phone"')}
            ${row('❓', T('howTitle'), T('howInfo'), '', '', 'data-p="how"')}
            ${row('🔄', T('app'), T('version') + ' ' + verText(), '', '', 'data-p="app"')}
          </div>`,
        wire(b) {
          b.querySelector('[data-p=name]').onclick = nameSheet;
          b.querySelector('[data-p=lang]').onclick = langSheet;
          b.querySelector('[data-p=phone]').onclick = () => openPage('phone');
          b.querySelector('[data-p=how]').onclick = () => openPage('how');
          b.querySelector('[data-p=app]').onclick = () => openPage('app');
        },
      };
    },
    phone() { return { title: T('phone'), html: '<div id="permList"></div>', wire: () => fillPerms($('#permList')) }; },
    how() {
      return { title: T('howTitle'), html: '<div class="list">' + row('🖌️', T('how1'), '', '', 'blue') + row('🌲', T('how2'), '', '', 'green') + row('🚲', T('how3'), '', '') + row('🔁', T('how4'), '', '') + '</div>' };
    },
    app() {
      return {
        title: T('app'),
        html: `<div class="list">${row('🧩', T('version'), verText(), '')}<div class="row"><span class="ic">🔄</span><span class="tx"><b>${T('checkUpdate')}</b></span><button class="btn small blue" id="chk">${T('open')}</button></div></div>`,
        wire(b) { b.querySelector('#chk').onclick = (e) => { e.target.textContent = T('updating'); checkUpd(true).finally(() => { e.target.textContent = T('open'); }); }; },
      };
    },
  };
  let appInfo = { versionName: '', web: BUILD };
  function verText() {
    const d = BUILD ? new Date(BUILD * 1000) : null;
    return (appInfo.versionName || '') + (d ? ' · ' + d.toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB') + ' ' + d.toLocaleTimeString(S.lang === 'he' ? 'he-IL' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
  }

  function tripSheet(id) {
    const t = S.trips.find((x) => x.id === id) || pend.find((x) => x.id === id);
    if (!t) return;
    sheet(`<h2>${esc(fmtDate(t.start))}</h2>
      <div class="list">
        ${row('★', T('points'), '', nf(t.pts), 'blue')}
        ${row('🖌️', T('newMetres'), '', fmtM(t.newM), 'blue')}
        ${row(t.cycleS > t.walkS ? '🚲' : '🚶', T('distance'), '', fmtM(t.m))}
        ${row('⏱️', T('duration'), '', fmtT((Math.max(t.end || 0, t.stopped || 0) - t.start) / 1000))}
        ${t.steps > 0 ? row('👣', T('steps'), '', nf(t.steps)) : ''}
        ${t.natM ? row('🌲', T('natureBonus'), '', fmtM(t.natM), 'green') : ''}
        ${t.fastM > 50 ? row('🚗', T('fastPart'), '', fmtM(t.fastM)) : ''}
        ${t.mock ? row('⚠️', T('mockTrip'), '', '') : ''}
      </div>
      <div class="acts"><button class="btn blue" id="show">${T('showOnMap')}</button></div>`);
    $('#show').onclick = () => { closeSheet(); showTrip(t); };
  }
  function showTrip(t) {
    const g = t.left ? { segs: t.segs, raw: t.raw } : store.get('gt.t.' + t.id, null);
    showTab('map');
    if (!g || !mapReady) return;
    const pts = g.segs.flat().concat(g.raw.filter(Boolean));
    map.getSource('focus').setData({ type: 'FeatureCollection', features: [segFeature(g.segs)] });
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    setFollow(false);
    map.fitBounds(b, { padding: { top: 90, bottom: 200, left: 40, right: 40 }, maxZoom: 17, duration: 800 });
    setTimeout(() => { if (mapReady) map.getSource('focus').setData(EMPTY); }, 12000);
  }

  function nameSheet() {
    sheet(`<h2>${T('name')}</h2><input class="txt" id="nm" maxlength="24" placeholder="${esc(T('namePh'))}" value="${esc(S.name)}">
      <div class="acts"><button class="btn blue" id="nmok">${T('done')}</button></div>`);
    const save = () => { S.name = $('#nm').value.trim().slice(0, 24); saveS(); closeSheet(); if (curPage === 'me') openPage('me', true); };
    $('#nmok').onclick = save;
    $('#nm').onkeydown = (e) => { if (e.key === 'Enter') save(); };
  }
  function langButtons() {
    return `<div class="seg"><button data-lang="en" class="${S.lang === 'en' ? 'on' : ''}">English</button><button data-lang="he" class="${S.lang === 'he' ? 'on' : ''}">עברית</button></div>`;
  }
  function wireLang(root, after) {
    root.querySelectorAll('[data-lang]').forEach((b) => {
      b.onclick = () => { setLang(b.dataset.lang); after(); };
    });
  }
  function setLang(l) {
    if (l === S.lang) return;
    S.lang = l; saveS(); applyLang();
    if (mapReady) for (const id of ['road-name', 'water-name', 'park-name', 'place']) map.setLayoutProperty(id, 'text-field', nameExpr());
    updDock(); updHud();
  }
  function langSheet() {
    const s = sheet(`<h2>${T('language')}</h2>${langButtons()}<div class="acts"><button class="btn blue" data-close>${T('done')}</button></div>`);
    wireLang(s, () => { langSheet(); if (curPage) openPage(curPage, true); });
  }

  // ---------- permissions ----------
  async function fillPerms(box) {
    if (!box) return;
    const p = await GT.perms();
    const item = (ok, ic, name, info, which, btn) => `<div class="row"><span class="ic ${ok ? 'green' : ''}">${ic}</span><span class="tx"><b>${esc(name)}</b><small>${esc(info)}</small></span>
      ${ok ? `<span class="ok">✓ ${T('allowed')}</span>` : `<button class="btn small blue" data-ask="${which}">${btn || T('allow')}</button>`}</div>`;
    box.innerHTML = '<div class="list">' +
      (p.gpsOn === false ? item(false, '🛰️', T('permGps'), T('permGpsInfo'), 'gps', T('open')) : '') +
      item(p.location, '📍', T('permLoc'), T('permLocInfo'), 'location') +
      item(p.activity, '👣', T('permAct'), T('permActInfo'), 'activity') +
      (p.platform === 'ios' ? '' : item(p.notifications, '🔔', T('permNote'), T('permNoteInfo'), 'notifications') +
        item(p.battery, '🔋', T('permBat'), T('permBatInfo'), 'battery', T('open'))) + '</div>';
    box.querySelectorAll('[data-ask]').forEach((b) => {
      b.onclick = async () => {
        const w = b.dataset.ask;
        if (w === 'battery') await GT.askBattery();
        else if (w === 'gps') await GT.openSettings({ what: 'gps' });
        else {
          const r = await GT.ask({ which: w });
          if (!r[w]) await GT.openSettings({}); // refused for good: the phone's settings page is the only way
          if (w === 'location' && r.location) GT.watch({ on: true });
        }
        fillPerms(box);
      };
    });
  }
  function openPerms() {
    const s = sheet(`<h2>${T('permTitle')}</h2><p>${T('permText')}</p><div id="permSheet"></div>
      <div class="acts"><button class="btn blue" data-close>${T('done')}</button></div>`);
    fillPerms(s.querySelector('#permSheet'));
  }
  function welcome() {
    const s = sheet(`<div class="hero"><div class="logo">Go Travel</div></div><h2>${T('welcomeTitle')}</h2><p>${T('welcomeText')}</p>
      <div class="h2">${T('language')}</div>${langButtons()}
      <div class="acts"><button class="btn green" id="wgo">${T('letsGo')}</button></div>`, { noX: true });
    wireLang(s, welcome);
    $('#wgo').onclick = async () => {
      S.seen = 1; saveS();
      openPerms();
      const p = await GT.ask({ which: 'location' });
      if (p.location) GT.watch({ on: true });
      fillPerms($('#permSheet'));
    };
  }

  // ---------- updates ----------
  function banner(text, btn, fn) {
    const b = $('#banner');
    b.innerHTML = `<span class="grow">${esc(text)}</span><button class="ghost" id="bnx">${T('later')}</button><button id="bnok">${esc(btn)}</button>`;
    b.hidden = false;
    $('#bnx').onclick = () => { b.hidden = true; };
    $('#bnok').onclick = () => { b.hidden = true; fn(); };
  }
  async function checkUpd(manual) {
    try {
      const r = await GT.checkUpdate({ site: SITE });
      if (r.state === 'ready') {
        if (!cur && Date.now() - opened < 20000 && !sheetOpen()) GT.applyUpdate();
        else banner(T('updReady'), T('restart'), () => { saveCur(); saveS(); GT.applyUpdate(); });
      } else if (manual) toast(T('upToDate'));
    } catch (e) { if (manual) toast(String((e && e.message) || e)); }
  }

  // ---------- back button ----------
  function onBack() {
    if (sheetOpen()) { const x = $('#layer [data-close]'); if (x) closeSheet(); return; }
    if (!$('#page').hidden) { pageBack(); return; }
    if (AppP && appInfo.platform !== 'ios') AppP.minimizeApp().catch(() => {});
  }

  // ---------- start ----------
  async function boot() {
    try { await GT.ready(); } catch (e) { /* old app */ }
    applyLang();
    try { appInfo = await GT.info(); } catch (e) { /* ignore */ }
    initMap();
    updHud(); updDock();
    $('#btnStart').onclick = startTrip;
    $('#btnStop').onclick = askFinish;
    $('#btnMe').onclick = () => setFollow(true);
    $('#hudLvl').onclick = () => showTab('me');
    $('#pBack').onclick = pageBack;
    document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.go); });
    setFollow(true);
    GT.addListener('fix', (f) => {
      moveMe(f);
      if (!f.live && cur) { clearTimeout(pumpSoon); pumpSoon = setTimeout(pump, 800); }
    });
    GT.addListener('resume', () => { pump(); checkUpd(false); });
    if (AppP) AppP.addListener('backButton', onBack);
    // a trip may be running in the app (page reloaded / updated mid-trip), or have stopped while the page was closed
    const st = await GT.status();
    if (st.running && !cur) { cur = eng.newTrip(st.startedAt || Date.now()); cur.id = Date.now().toString(36); saveCur(); }
    if (!st.running && cur) { cur.idx = cur.idx || 0; await stopTripAfterKill(); }
    setRecording(!!cur);
    const p = await GT.perms();
    if (p.location) GT.watch({ on: true });
    if (!S.seen) welcome();
    pump();
    setInterval(() => { if (cur) updDock(); }, 1000);
    setInterval(() => { if (cur || pend.length) pump(); }, 5000);
    setTimeout(() => checkUpd(false), 3000);
    setInterval(() => checkUpd(false), 30 * 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); else { saveS(); saveCur(); } });
  }
  let pumpSoon = 0;
  /** The app stopped recording while the page was away (phone restarted, app closed from the phone's settings). */
  async function stopTripAfterKill() {
    const r = await GT.read({ from: cur.idx });
    const t = cur;
    t.left = r.lines ? r.lines.split('\n').filter(Boolean) : [];
    t.stopped = Date.now();
    pend.push(t);
    cur = null;
    saveCur();
    await GT.clear();
  }

  // test hooks (used by tools/page_test.py)
  window.__gt = { S: () => S, cur: () => cur, pend: () => pend, painted: () => painted.size, GT, pump, map: () => map, ready: () => mapReady, T, setLang, showTab, stopTrip, startTrip };

  boot().catch((e) => { console.error(e); });
})();
