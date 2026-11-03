// SpecTree v6 engine: the free-order model from the full-model Grace run (free_raw, confusion answer model),
// run in the browser. Every library compound keeps a log-probability; each answer adds
// w[technique] * log P(answer | that compound's clean answer); the next question is the one with the most
// information about the 256 leading compounds. Mirrors fulllib.run_reading (router "free", score "raw",
// profile "confusion"), with one change: ties among equally likely compounds are broken by a fixed
// rank (c * 7919 mod N) instead of numpy's argpartition order, so a page and a script give the same game.
"use strict";

const GROUPS = ["IR", "MS", "1H", "13C", "GATE", "L3"];
const EVIDENCE = {all: ["IR", "1H", "13C", "MS"], nmr_ms: ["1H", "13C", "MS"]};

function makeEngine(D, B) {
  // D: questions and settings (JSON); B: typed arrays {clean: Uint8Array[Q*N], M: Float32Array, Moff: Uint32Array,
  // H: Float32Array, Hoff: Uint32Array, rel: Float32Array}
  const Q = D.Q, N = D.N, ncat = D.ncat, tech = D.tech;
  const group = tech.map(t => GROUPS.indexOf(t));
  const rank = new Int32Array(N);
  for (let c = 0; c < N; c++) rank[c] = (c * 7919) % N;
  const byKey = lp => (x, y) => (lp[y] - lp[x]) || (rank[x] - rank[y]);

  function settings(ev) {
    const s = D.settings[ev];
    return {ev, w: s.weights, tau: s.tau, K: s.k_route, rp: s.rel_power, irw: s.ir_weight, maxExtra: s.max_extra,
            stop: s.stop_max, minIg: s.min_ig, allowed: tech.map(t => EVIDENCE[ev].includes(t))};
  }
  function newGame(ev) {
    return {cfg: settings(ev), logL: new Float64Array(N), asked: new Uint8Array(Q), order: [], answers: []};
  }
  function lpOf(g) {
    if (g.cfg.tau === 1) return g.logL;
    const lp = new Float64Array(N);
    for (let c = 0; c < N; c++) lp[c] = g.logL[c] / g.cfg.tau;
    return lp;
  }
  function answer(g, q, a) {
    a = Math.max(0, Math.min(ncat[q] - 1, a | 0));
    const A = ncat[q], off = B.Moff[q], w = g.cfg.w[group[q]], lg = new Float64Array(A);
    for (let b = 0; b < A; b++) lg[b] = Math.log(B.M[off + b * A + a]);
    const base = q * N, L = g.logL, cl = B.clean;
    for (let c = 0; c < N; c++) L[c] += w * lg[cl[base + c]];
    g.asked[q] = 1; g.order.push(q); g.answers.push(a);
    return a;
  }
  function p1Of(lp) {
    let m = -Infinity;
    for (let c = 0; c < N; c++) if (lp[c] > m) m = lp[c];
    let s = 0;
    for (let c = 0; c < N; c++) s += Math.exp(lp[c] - m);
    return 1 / s;
  }
  function topK(lp, K) {
    // the K most likely compounds, ties broken by rank (same as numpy lexsort((rank, -lp))[:K])
    const srt = Float64Array.from(lp).sort();
    const t = srt[N - K], sel = [], tie = [];
    for (let c = 0; c < N; c++) { if (lp[c] > t) sel.push(c); else if (lp[c] === t) tie.push(c); }
    tie.sort((x, y) => rank[x] - rank[y]);
    for (let i = 0; sel.length < K && i < tie.length; i++) sel.push(tie[i]);
    return sel.sort(byKey(lp));
  }
  function infoGain(g, lp) {
    const cfg = g.cfg, top = topK(lp, cfg.K), K = top.length;
    let mx = -Infinity;
    for (const c of top) if (lp[c] > mx) mx = lp[c];
    const p = new Float64Array(K);
    let s = 0;
    for (let i = 0; i < K; i++) { p[i] = Math.exp(lp[top[i]] - mx); s += p[i]; }
    for (let i = 0; i < K; i++) p[i] /= s;
    const ig = new Float64Array(Q).fill(-1);
    for (let q = 0; q < Q; q++) {
      if (!cfg.allowed[q] || g.asked[q]) continue;
      const A = ncat[q], W = new Float64Array(A), base = q * N, off = B.Moff[q], hoff = B.Hoff[q];
      for (let i = 0; i < K; i++) W[B.clean[base + top[i]]] += p[i];
      let HA = 0, HAC = 0;
      for (let a = 0; a < A; a++) {
        let PA = 0;
        for (let b = 0; b < A; b++) PA += W[b] * B.M[off + b * A + a];
        HA -= PA * Math.log(PA + 1e-12);
      }
      for (let b = 0; b < A; b++) HAC += W[b] * B.H[hoff + b];
      ig[q] = HA - HAC;
    }
    return ig;
  }
  function nextQuestion(g) {
    // -1 when the model would stop: one compound at the stop probability, the question limit, or nothing useful left
    const lp = lpOf(g), cfg = g.cfg;
    if (p1Of(lp) >= cfg.stop || g.order.length >= cfg.maxExtra) return -1;
    const ig = infoGain(g, lp);
    let best = -1, bs = -Infinity;
    for (let q = 0; q < Q; q++) {
      let sc = ig[q] > cfg.minIg ? ig[q] * Math.pow(B.rel[q], cfg.rp) : -1;
      if (cfg.irw !== 1 && tech[q] === "IR") sc *= cfg.irw;
      if (sc > bs) { bs = sc; best = q; }
    }
    return bs > 0 ? best : -1;
  }
  function ranking(g, n) {
    // the n most likely compounds with their posterior probabilities
    const lp = lpOf(g);
    let m = -Infinity;
    for (let c = 0; c < N; c++) if (lp[c] > m) m = lp[c];
    let s = 0;
    for (let c = 0; c < N; c++) s += Math.exp(lp[c] - m);
    return topK(lp, n).map(c => [c, Math.exp(lp[c] - m) / s]);
  }
  function rankOf(g, c) {
    // pessimistic rank of compound c (ties count against it), as the Grace scoring does: 1 = top
    const lp = lpOf(g), v = lp[c];
    let r = 0;
    for (let i = 0; i < N; i++) if (lp[i] >= v) r++;
    return r;
  }
  function autoPlay(ev, auto) {
    // the whole game with automatic answers auto[q]
    const g = newGame(ev);
    for (;;) { const q = nextQuestion(g); if (q < 0) break; answer(g, q, auto[q]); }
    return g;
  }
  return {Q, N, newGame, answer, nextQuestion, ranking, rankOf, autoPlay, p1: g => p1Of(lpOf(g))};
}

if (typeof module !== "undefined") module.exports = {makeEngine};
