/* Go Travel engine: turns raw GPS fixes into painted road metres and points.
 * No screen code here, so the same file runs in the game page and in the Node tests (tools/engine_test.js).
 *
 * Roads come from the OpenStreetMap vector tiles the map shows (OpenFreeMap, zoom 14, layer "transportation"):
 * each tile is decoded once, its lines are indexed, and each fix is snapped to the nearest walkable line.
 * The ground is split in cells of 0.0001 degrees (about 11 x 9 m); the metres you walk inside a cell nobody painted
 * before are new metres (1 point each); a cell is painted for good once you enter it.
 * Forests and nature reserves (layers "landcover" class wood, "park" classes nature_reserve/national_park/protected_area)
 * give double points.
 */
(function (root) {
  'use strict';
  const Z = 14;
  const R = {
    MAX_ACC: 25,          // m: fixes less accurate than this are ignored
    MAX_SPEED: 30 / 3.6,  // m/s: faster than a bike = car/train, not counted
    WALK_SPEED: 7.5 / 3.6,// m/s: below = walking, above = cycling
    MIN_MOVE: 5,          // m: smaller moves are GPS jitter
    SAMPLE: 4,            // m: distance between snap samples along a move
    CELL: 1e-4,           // degrees
    NATURE_X: 2,          // points multiplier in forests / reserves
    GAP_S: 120, GAP_M: 400, // a longer GPS gap is not painted (we don't know which way you went)
    JOIN_M: 30,           // snapped points closer than this continue the same painted line
    BOX: [34.2, 29.45, 35.95, 33.35], // the game counts trips in Israel only (lon/lat box)
  };
  const SKIP_CLASS = { motorway: 1, rail: 1, transit: 1, ferry: 1, aerialway: 1, raceway: 1, busway: 1, bridge: 1 };
  const NATURE_PARK = { nature_reserve: 1, national_park: 1, protected_area: 1 };

  const rad = Math.PI / 180;
  function dist(lo1, la1, lo2, la2) {
    const x = (lo2 - lo1) * Math.cos((la1 + la2) / 2 * rad) * 111320, y = (la2 - la1) * 110574;
    return Math.sqrt(x * x + y * y);
  }
  function tileOf(lo, la) {
    const n = 1 << Z, r = la * rad;
    return [Math.floor((lo + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
  }
  function tileLo(x) { return x / (1 << Z) * 360 - 180; }
  function tileLa(y) { const n = Math.PI - 2 * Math.PI * y / (1 << Z); return Math.atan(Math.sinh(n)) / rad; }
  function cellKey(lo, la) { return Math.round(la / R.CELL) + ':' + Math.round(lo / R.CELL); }

  const G = 16; // index buckets per tile side

  function decodeTile(buf, x, y) {
    const VT = root.VT || (typeof require === 'function' ? requireVT() : null);
    const vt = new VT.VectorTile(new VT.Pbf(new Uint8Array(buf)));
    const lo0 = tileLo(x), lo1 = tileLo(x + 1), la0 = tileLa(y), la1 = tileLa(y + 1);
    const t = { x, y, lo0, lo1, la0, la1, segs: [], idx: new Array(G * G), nature: [] };
    for (let i = 0; i < G * G; i++) t.idx[i] = [];
    const conv = (ext) => (p) => [lo0 + (lo1 - lo0) * p.x / ext, la0 + (la1 - la0) * p.y / ext];
    const tr = vt.layers.transportation;
    if (tr) for (let i = 0; i < tr.length; i++) {
      const f = tr.feature(i);
      if (f.type !== 2) continue;
      const c = String(f.properties.class || '');
      if (SKIP_CLASS[c] || c.endsWith('_construction')) continue;
      const cv = conv(f.extent);
      for (const line of f.loadGeometry()) {
        for (let k = 1; k < line.length; k++) {
          const a = cv(line[k - 1]), b = cv(line[k]);
          const s = { a, b, c, sub: f.properties.subclass || '' };
          const id = t.segs.push(s) - 1;
          // put the segment in every bucket its box touches
          const bx0 = Math.max(0, Math.min(G - 1, Math.floor(Math.min(line[k - 1].x, line[k].x) / f.extent * G)));
          const bx1 = Math.max(0, Math.min(G - 1, Math.floor(Math.max(line[k - 1].x, line[k].x) / f.extent * G)));
          const by0 = Math.max(0, Math.min(G - 1, Math.floor(Math.min(line[k - 1].y, line[k].y) / f.extent * G)));
          const by1 = Math.max(0, Math.min(G - 1, Math.floor(Math.max(line[k - 1].y, line[k].y) / f.extent * G)));
          for (let bx = bx0; bx <= bx1; bx++) for (let by = by0; by <= by1; by++) t.idx[by * G + bx].push(id);
        }
      }
    }
    const addPolys = (layer, ok) => {
      if (!layer) return;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.type !== 3 || !ok(f.properties)) continue;
        const cv = conv(f.extent);
        t.nature.push(f.loadGeometry().map((ring) => ring.map(cv)));
      }
    };
    addPolys(vt.layers.landcover, (p) => p.class === 'wood');
    addPolys(vt.layers.park, (p) => NATURE_PARK[p.class]);
    return t;
  }
  let _vt = null;
  function requireVT() {
    if (!_vt) { _vt = { VectorTile: require('@mapbox/vector-tile').VectorTile, Pbf: require('pbf') }; }
    return _vt;
  }

  /** Nearest point on segment a-b to p, in metres-ish local coordinates. */
  function nearestOnSeg(lo, la, s) {
    const k = Math.cos(la * rad);
    const ax = s.a[0] * k, ay = s.a[1], bx = s.b[0] * k, by = s.b[1], px = lo * k, py = la;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let u = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    u = Math.max(0, Math.min(1, u));
    const qlo = s.a[0] + (s.b[0] - s.a[0]) * u, qla = s.a[1] + (s.b[1] - s.a[1]) * u;
    return [qlo, qla, dist(lo, la, qlo, qla)];
  }

  // even-odd test over all rings (outer + holes)
  function inPoly(lo, la, rings) {
    let inside = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > la) !== (yj > la) && lo < (xj - xi) * (la - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function create(opts) {
    const tiles = new Map();     // "x/y" -> Promise<tile>
    const fetchTile = opts.fetchTile; // (z, x, y) -> Promise<ArrayBuffer>
    function getTile(x, y) {
      const key = x + '/' + y;
      let p = tiles.get(key);
      if (!p) {
        p = fetchTile(Z, x, y).then((buf) => decodeTile(buf, x, y));
        p.catch(() => tiles.delete(key)); // failed (offline): try again next time
        tiles.set(key, p);
        if (tiles.size > 60) tiles.delete(tiles.keys().next().value);
      }
      return p;
    }
    /** The tiles a circle of tol metres around the point touches. */
    function tilesAround(lo, la, tol) {
      const dLo = tol / (111320 * Math.cos(la * rad)), dLa = tol / 110574;
      const a = tileOf(lo - dLo, la + dLa), b = tileOf(lo + dLo, la - dLa), out = [];
      for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) out.push(getTile(x, y));
      return Promise.all(out);
    }
    async function snap(lo, la, tol) {
      const ts = await tilesAround(lo, la, tol);
      let best = null;
      for (const t of ts) {
        const fx = (lo - t.lo0) / (t.lo1 - t.lo0), fy = (la - t.la0) / (t.la1 - t.la0);
        const pad = tol / ((t.lo1 - t.lo0) * 111320 * Math.cos(la * rad)) * G;
        const bx0 = Math.max(0, Math.floor(fx * G - pad)), bx1 = Math.min(G - 1, Math.floor(fx * G + pad));
        const by0 = Math.max(0, Math.floor(fy * G - pad)), by1 = Math.min(G - 1, Math.floor(fy * G + pad));
        const seen = new Set();
        for (let bx = bx0; bx <= bx1; bx++) for (let by = by0; by <= by1; by++) {
          for (const id of t.idx[by * G + bx]) {
            if (seen.has(id)) continue;
            seen.add(id);
            const q = nearestOnSeg(lo, la, t.segs[id]);
            if (q[2] <= tol && (!best || q[2] < best.d)) best = { lo: q[0], la: q[1], d: q[2], c: t.segs[id].c };
          }
        }
      }
      return best;
    }
    async function nature(lo, la) {
      const t = await getTile(...tileOf(lo, la));
      for (const rings of t.nature) if (inPoly(lo, la, rings)) return true;
      return false;
    }

    /** A new trip record. */
    function newTrip(t) {
      return { start: t, end: t, m: 0, newM: 0, pts: 0, natM: 0, steps: 0, walkS: 0, cycleS: 0, fastM: 0, fastS: 0,
        last: null, snapLast: null, segs: [], raw: [], idx: 0, mock: 0, cells: [], win: [] };
    }

    /** Takes back everything counted after window entry k (that stretch turned out to be too fast). */
    function undoAfter(trip, k, painted) {
      const W = trip.win, e = W[k];
      for (let i = W.length - 1; i > k; i--) {
        const w = W[i];
        if (w.mode === 'f') continue; // already booked as too fast
        for (const key of w.cells) painted.delete(key);
        trip.cells.length -= w.cells.length;
        trip.newM -= w.gain; trip.natM -= w.nat; trip.pts -= w.gain + w.nat * (R.NATURE_X - 1);
        if (w.mode === 'w') trip.walkS -= w.dt; else trip.cycleS -= w.dt;
        trip.m -= w.d; trip.fastM += w.d; trip.fastS += w.dt;
        w.mode = 'f'; w.cells = []; w.gain = 0; w.nat = 0;
      }
      trip.segs.length = e.segN;
      if (e.segN) trip.segs[e.segN - 1].length = e.segLastN;
      for (let i = k + 1; i < W.length; i++) { W[i].segN = e.segN; W[i].segLastN = e.segLastN; }
      trip.snapLast = null; trip.open = null;
    }

    /**
     * Feeds one fix {t, la, lo, ac, st, mk} into the trip. painted: Set of painted cell keys (shared by all trips).
     * Speed is judged over the last 30 s, so a car slowing down at a corner still counts as a car; when a stretch
     * turns out too fast, what it painted is taken back.
     * Returns {fast: true} when the move was too fast to count, {gain} for new metres.
     * Throws when a needed map tile can't be loaded (offline); the caller keeps the fix and tries again later.
     */
    async function addFix(trip, f, painted) {
      if (f.mk) { trip.mock = 1; return { mock: true }; }
      if (!(f.ac <= R.MAX_ACC)) return { skip: 'accuracy' };
      if (f.lo < R.BOX[0] || f.la < R.BOX[1] || f.lo > R.BOX[2] || f.la > R.BOX[3]) { trip.last = null; trip.snapLast = null; return { skip: 'outside' }; }
      if (f.st >= 0 && f.st > trip.steps) trip.steps = f.st;
      const last = trip.last;
      const fix = { t: f.t, la: f.la, lo: f.lo };
      if (!last) {
        trip.last = fix; trip.raw.push([f.lo, f.la]);
        trip.win = [{ t: f.t, all: 0, cells: [], gain: 0, nat: 0, segN: 0, segLastN: 0, mode: 'w', dt: 0, d: 0 }]; trip.all = 0;
        return {};
      }
      const dt = (f.t - last.t) / 1000;
      if (dt <= 0) return { skip: 'time' };
      const d = dist(last.lo, last.la, f.lo, f.la);
      if (d < Math.max(R.MIN_MOVE, (f.ac || 0) * 0.6)) return { skip: 'still' };
      const v = d / dt;
      if (v > R.MAX_SPEED * 1.5 || (dt > R.GAP_S && d > R.GAP_M)) {
        // clearly a vehicle, or a long GPS gap: nothing between the two fixes is painted
        const fast = v > R.MAX_SPEED;
        trip.end = f.t; trip.last = fix; trip.snapLast = null;
        trip.raw.push(null, [f.lo, f.la]);
        if (!fast) { trip.win = [{ t: f.t, all: 0, cells: [], gain: 0, nat: 0, segN: trip.segs.length, segLastN: 0, mode: 'w', dt: 0, d: 0 }]; trip.all = 0; trip.open = null; return { gap: true }; }
        trip.fastM += d; trip.fastS += dt; trip.all = (trip.all || 0) + d;
        const ls = trip.segs[trip.segs.length - 1];
        trip.win.push({ t: f.t, all: trip.all, cells: [], gain: 0, nat: 0, segN: trip.segs.length, segLastN: ls ? ls.length : 0, mode: 'f', dt, d }); trip.open = null;
        while (trip.win.length > 2 && f.t - trip.win[1].t > 60000) trip.win.shift();
        return { fast: true, v };
      }
      const tol = Math.max(12, Math.min(25, (f.ac || 10) + 6));
      const n = Math.max(1, Math.ceil(d / R.SAMPLE));
      // load every tile this move needs first, so a failed download (offline) changes nothing and the fix can be retried
      const need = [];
      for (let i = 0; i <= n; i += Math.max(1, Math.floor(n / 8))) need.push(tilesAround(last.lo + (f.lo - last.lo) * i / n, last.la + (f.la - last.la) * i / n, tol + 5));
      need.push(tilesAround(f.lo, f.la, tol + 5));
      await Promise.all(need);
      const cells = [];
      let gain = 0, natGain = 0;
      for (let i = 1; i <= n; i++) {
        const lo = last.lo + (f.lo - last.lo) * i / n, la = last.la + (f.la - last.la) * i / n;
        const s = await snap(lo, la, tol);
        if (!s) { trip.snapLast = null; trip.open = null; continue; }
        const p = [Math.round(s.lo * 1e6) / 1e6, Math.round(s.la * 1e6) / 1e6];
        const sl = trip.snapLast;
        const joined = sl && dist(sl[0], sl[1], p[0], p[1]) < R.JOIN_M;
        // a cell nobody painted becomes "open": the metres walked inside it count, until you leave it
        const key = cellKey(s.lo, s.la);
        if (!painted.has(key)) {
          painted.add(key);
          cells.push(key);
          trip.cells.push(key);
          trip.open = key;
          trip.openNat = (await nature(s.lo, s.la)) ? 1 : 0;
        } else if (key !== trip.open) trip.open = null;
        if (joined && key === trip.open) {
          const dm = dist(sl[0], sl[1], p[0], p[1]);
          gain += dm;
          if (trip.openNat) natGain += dm;
        }
        if (joined) {
          const seg = trip.segs[trip.segs.length - 1];
          const q = seg[seg.length - 1];
          if (dist(q[0], q[1], p[0], p[1]) >= 3) seg.push(p);
        } else trip.segs.push([p]);
        trip.snapLast = p;
      }
      trip.newM += gain; trip.natM += natGain; trip.pts += gain + natGain * (R.NATURE_X - 1);
      trip.m += d; trip.all = (trip.all || 0) + d;
      trip.end = f.t;
      trip.last = fix;
      const r = trip.raw[trip.raw.length - 1];
      if (!r || dist(r[0], r[1], f.lo, f.la) >= 10) trip.raw.push([Math.round(f.lo * 1e6) / 1e6, Math.round(f.la * 1e6) / 1e6]);
      // speed over the last 30 s (or the whole trip while it is younger)
      const W = trip.win;
      let k = 0;
      for (let i = W.length - 1; i >= 0; i--) if (f.t - W[i].t >= 30000) { k = i; break; }
      const span = (f.t - W[k].t) / 1000, wv = span > 0 ? (trip.all - W[k].all) / span : v;
      const mode = wv < R.WALK_SPEED ? 'w' : 'c';
      if (mode === 'w') trip.walkS += dt; else trip.cycleS += dt;
      const lastSeg = trip.segs[trip.segs.length - 1];
      W.push({ t: f.t, all: trip.all, cells, gain, nat: natGain, segN: trip.segs.length, segLastN: lastSeg ? lastSeg.length : 0, mode, dt, d });
      if (span >= 20 && wv > R.MAX_SPEED) { undoAfter(trip, k, painted); return { fast: true, v: wv }; }
      while (W.length > 2 && f.t - W[1].t > 60000) W.shift();
      return { gain: Math.round(gain) };
    }

    return { snap, nature, newTrip, addFix, getTile };
  }

  const api = { create, dist, cellKey, tileOf, R, Z };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GTEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
