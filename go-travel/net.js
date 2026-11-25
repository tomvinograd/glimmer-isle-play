/* Go Travel online: friends, leaderboards and shared routes on Firebase Realtime Database (REST, no SDK).
 * Same Firebase project as Glimmer Isle; Go Travel lives under /gt (rules: tools/firebase-rules.json).
 * Sign-in is anonymous: the phone keeps its refresh token, so the account is this phone's game.
 *   /gt/p/<uid>          public profile {n name, pts, nm new metres, m, st steps, tr trips, ac achievements, lv, wk week, wp week points, at}
 *   /gt/c/<CODE>         invite code -> uid
 *   /gt/f/<uid>/<uid2>   friends (both sides written when one enters the other's code)
 *   /gt/r/<uid>/<trip>   shared routes {s start, n new metres, g painted lines}, readable by friends only
 */
(function (root) {
  'use strict';
  const FB = { key: 'AIzaSyCPNEfi4e5nUel_k9FMiUMkdGZL1-I5Rc4', db: 'https://glimmerisle-93c86-default-rtdb.europe-west1.firebasedatabase.app' };
  const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const KEEP_ROUTES = 30;

  function create(o) {
    const doFetch = o.fetch || ((u, x) => root.fetch(u, x));
    const load = o.load, save = o.save; // load() -> {u, r} | null; save({u, r})
    let acct = load() || null, tok = null, tokAt = 0;

    async function token(force) {
      if (tok && !force && Date.now() - tokAt < 50 * 60000) return tok;
      if (acct && acct.r) {
        const r = await doFetch('https://securetoken.googleapis.com/v1/token?key=' + FB.key, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(acct.r) });
        if (r.ok) { const j = await r.json(); acct = { u: j.user_id, r: j.refresh_token }; save(acct); tok = j.id_token; tokAt = Date.now(); return tok; }
        if (r.status < 400 || r.status >= 500) throw new Error('net ' + r.status);
        // refused for good (account removed): start a new one
      }
      const r = await doFetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FB.key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
      if (!r.ok) throw new Error('signup ' + r.status);
      const j = await r.json();
      acct = { u: j.localId, r: j.refreshToken }; save(acct);
      tok = j.idToken; tokAt = Date.now();
      return tok;
    }
    async function call(path, opt, q) {
      for (let k = 0; ; k++) {
        const t = await token(k > 0);
        const r = await doFetch(FB.db + path + '.json?auth=' + encodeURIComponent(t) + (q ? '&' + q : ''), Object.assign({ cache: 'no-store' }, opt || {}));
        if (r.status === 401 && k === 0) continue; // token ran out: once more with a fresh one
        if (!r.ok) { const e = new Error('db ' + r.status + ' ' + path); e.status = r.status; throw e; }
        return r.json();
      }
    }
    const put = (path, v) => call(path, { method: 'PUT', body: JSON.stringify(v) });
    const del = (path) => call(path, { method: 'DELETE' });
    const uid = () => (acct ? acct.u : null);

    async function myCode(have) {
      await token();
      if (have) {
        const v = await call('/gt/c/' + have);
        if (v === acct.u) return have;
      }
      for (let k = 0; k < 6; k++) {
        let c = '';
        for (let i = 0; i < 6; i++) c += CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)];
        try { await put('/gt/c/' + c, acct.u); return c; } catch (e) { if (e.status !== 401 && e.status !== 403) throw e; } // taken: try another
      }
      throw new Error('no code');
    }
    const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    /** Adds the friend behind the code on both sides. Returns their uid, or {err: 'code'|'self'}. */
    async function addByCode(code) {
      code = cleanCode(code);
      if (code.length !== 6) return { err: 'code' };
      await token();
      const f = await call('/gt/c/' + code);
      if (!f || typeof f !== 'string') return { err: 'code' };
      if (f === acct.u) return { err: 'self' };
      const now = { '.sv': 'timestamp' };
      await put('/gt/f/' + acct.u + '/' + f, now);
      await put('/gt/f/' + f + '/' + acct.u, now);
      return { uid: f };
    }
    async function removeFriend(f) {
      await del('/gt/f/' + acct.u + '/' + f);
      try { await del('/gt/f/' + f + '/' + acct.u); } catch (e) { /* their side may be gone already */ }
    }
    async function friends() {
      await token();
      const ids = Object.keys((await call('/gt/f/' + acct.u)) || {});
      const ps = await Promise.all(ids.map((id) => call('/gt/p/' + id).then((p) => (p ? { ...p, uid: id } : null)).catch(() => null)));
      return ps.filter(Boolean);
    }
    async function pushProfile(p) {
      await token();
      await put('/gt/p/' + acct.u, { ...p, at: { '.sv': 'timestamp' } });
    }
    /** The top of everyone: by all-time points, or by this week's points (wk = this week's key). */
    async function board(week) {
      const q = week ? 'orderBy=%22wp%22&limitToLast=100' : 'orderBy=%22pts%22&limitToLast=50';
      const all = (await call('/gt/p', null, q)) || {};
      let list = Object.keys(all).map((id) => ({ ...all[id], uid: id }));
      if (week) list = list.filter((p) => p.wk === week).map((p) => ({ ...p, pts: p.wp }));
      return list.sort((a, b) => b.pts - a.pts).slice(0, 50);
    }
    async function pushRoute(id, r) {
      await token();
      await put('/gt/r/' + acct.u + '/' + id, r);
    }
    async function pruneRoutes() {
      const ks = Object.keys((await call('/gt/r/' + acct.u, null, 'shallow=true')) || {}).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
      for (const k of ks.slice(0, Math.max(0, ks.length - KEEP_ROUTES))) await del('/gt/r/' + acct.u + '/' + k);
    }
    const delRoute = (id) => del('/gt/r/' + acct.u + '/' + id);
    async function routes(f) { return (await call('/gt/r/' + f)) || {}; }

    return { token, uid, myCode, addByCode, removeFriend, friends, pushProfile, board, pushRoute, delRoute, pruneRoutes, routes, cleanCode, KEEP_ROUTES };
  }

  // painted lines <-> a short text: points as 1e-5 degree steps from the one before, lines split by '|'
  function encodeLines(segs) {
    return segs.filter((s) => s.length > 1).map((s) => {
      let plo = 0, pla = 0;
      return s.map((p) => { const lo = Math.round(p[0] * 1e5), la = Math.round(p[1] * 1e5), t = (lo - plo) + ',' + (la - pla); plo = lo; pla = la; return t; }).join(';');
    }).join('|');
  }
  function decodeLines(g) {
    if (!g) return [];
    return g.split('|').map((s) => { let lo = 0, la = 0; return s.split(';').map((t) => { const [a, b] = t.split(',').map(Number); lo += a; la += b; return [lo / 1e5, la / 1e5]; }); }).filter((s) => s.length > 1);
  }

  const api = { create, encodeLines, decodeLines, FB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GTNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
