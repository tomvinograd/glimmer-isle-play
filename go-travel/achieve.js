/* Go Travel achievements: families of goals with tiers; each tier reached gives extra points once.
 * No screen code here (the Node tests load it too). The game computes the stats (stats()) and calls check().
 * Marked trails (trails.json, from OpenStreetMap hiking routes, see tools/make_trails.py) count the share of the
 * trail's sample points (every SAMPLE_M along it) you have painted: a point counts when you painted a cell within
 * NEAR cells of it. Long national and regional trails ("featured") give points at 5, 25, 50 and 100%; every other
 * trail gives its points when completed. Points grow with the trail's length.
 */
(function (root) {
  'use strict';
  // stat: the number in stats() the tiers compare against; unit: how the game shows it (km = metres / 1000)
  const LIST = [
    { id: 'paint', ic: '🖌️', stat: 'newM', unit: 'km', tiers: [1000, 5000, 25000, 100000, 250000], pts: [50, 100, 250, 500, 1000] },
    { id: 'trips', ic: '🧭', stat: 'trips', unit: 'n', tiers: [1, 5, 20, 50, 100], pts: [20, 50, 100, 200, 400] },
    { id: 'long', ic: '🥾', stat: 'longestM', unit: 'km', tiers: [3000, 5000, 10000, 20000], pts: [50, 100, 200, 400] },
    { id: 'nature', ic: '🌲', stat: 'natM', unit: 'km', tiers: [500, 2000, 10000, 30000], pts: [50, 100, 250, 500] },
    { id: 'dirt', ic: '🏞️', stat: 'dirtM', unit: 'km', tiers: [1000, 5000, 20000, 50000], pts: [50, 100, 250, 500] },
    { id: 'peaks', ic: '⛰️', stat: 'peaks', unit: 'n', tiers: [1, 3, 10, 25], pts: [100, 200, 500, 1000] },
    { id: 'high', ic: '🏔️', stat: 'maxEle', unit: 'ele', tiers: [500, 1000], pts: [200, 500] },
    { id: 'steps', ic: '👣', stat: 'maxSteps', unit: 'n', tiers: [5000, 10000, 20000], pts: [50, 100, 200] },
    { id: 'streak', ic: '🔥', stat: 'streak', unit: 'days', tiers: [3, 7, 14, 30], pts: [50, 100, 250, 500] },
    { id: 'bike', ic: '🚲', stat: 'longestBikeM', unit: 'km', tiers: [10000, 25000, 50000], pts: [50, 150, 300] },
    { id: 'dawn', ic: '🌅', stat: 'dawn', unit: 'n', tiers: [1, 10], pts: [50, 150] },
    { id: 'friends', ic: '🤝', stat: 'friends', unit: 'n', tiers: [1, 5, 10], pts: [50, 100, 200] },
    { id: 'trailsDone', ic: '🚩', stat: 'trailsDone', unit: 'n', tiers: [1, 3, 10, 25], pts: [100, 200, 500, 1000] },
  ];
  // marked trails: share of the trail painted, in percent
  const TRAIL_DONE = 90;  // % that counts as the whole trail (GPS gaps, bits the map's paths don't have)
  const SAMPLE_M = 40, NEAR = 2;
  const FEATURED_KM = 10; // national and regional trails at least this long get steps on the way
  const PTS_PER_KM = 20;
  function trailTiers(t) {
    const shown = t.featured ? [5, 25, 50, 100] : [100];
    const pts = shown.map((x) => Math.max(50, Math.round(t.km * PTS_PER_KM * x / 100 / 10) * 10));
    return { shown, tiers: shown.map((x) => (x === 100 ? TRAIL_DONE : x)), pts };
  }

  /** Best run of days in a row with a trip, from trip start times (local days). */
  function bestStreak(starts) {
    const days = [...new Set(starts.map((t) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; }))].sort((a, b) => a - b);
    let best = 0, run = 0;
    for (let i = 0; i < days.length; i++) { run = i && days[i] === days[i - 1] + 1 ? run + 1 : 1; if (run > best) best = run; }
    return best;
  }

  /** Points every SAMPLE_M metres along lines [[[lo, la], ...], ...], as a flat [lo, la, lo, la, ...]. */
  function samples(lines) {
    const out = [];
    for (const s of lines) {
      let left = 0;
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1], b = s[i];
        const d = Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180) * 111320, (b[1] - a[1]) * 110574);
        while (left <= d) { const u = d ? left / d : 0; out.push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u); left += SAMPLE_M; }
        left -= d;
      }
    }
    return out;
  }
  /** Percent of a trail's sample points painted. pts: flat [lo, la, lo, la, ...]; painted: Set of cell keys. */
  function trailPct(pts, painted, cell) {
    const n = pts.length / 2;
    if (!n) return 0;
    let done = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const lo = Math.round(pts[i] / cell), la = Math.round(pts[i + 1] / cell);
      let hit = false;
      for (let a = -NEAR; a <= NEAR && !hit; a++) for (let b = -NEAR; b <= NEAR && !hit; b++) if (painted.has((la + a) + ':' + (lo + b))) hit = true;
      if (hit) done++;
    }
    return done / n * 100;
  }

  /** Every family and trail with how far you got: [{id, ic, val, tier (tiers reached), next, tiers, pts, trail}]. */
  function progress(stats, trails) {
    const out = LIST.map((a) => {
      const val = stats[a.stat] || 0;
      let tier = 0;
      while (tier < a.tiers.length && val >= a.tiers[tier]) tier++;
      return { ...a, val, tier, next: a.tiers[tier] };
    });
    for (const t of trails || []) {
      const val = stats.trail ? stats.trail[t.id] || 0 : 0;
      const { shown, tiers, pts } = trailTiers(t);
      let tier = 0;
      while (tier < tiers.length && val >= tiers[tier]) tier++;
      out.push({ id: 'trail_' + t.id, ic: '🚩', trail: t, unit: 'pct', val, tier, tiers, shown, pts, next: tiers[tier] });
    }
    return out;
  }

  /** Tiers reached that are not in `have` ({id: tiers already given}). Returns [{id, tier, pts}]; tier counts from 1. */
  function check(stats, have, trails) {
    const out = [];
    for (const a of progress(stats, trails)) for (let k = (have[a.id] || 0); k < a.tier; k++) out.push({ id: a.id, tier: k + 1, pts: a.pts[k] });
    return out;
  }

  const api = { LIST, progress, check, bestStreak, trailPct, samples, trailTiers, TRAIL_DONE, FEATURED_KM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GTAchieve = api;
})(typeof window !== 'undefined' ? window : globalThis);
