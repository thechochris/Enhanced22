// Finds the plays in the full-game broadcast replay, so its audio lines up without anchors.
//
// The broadcast is scanned the same way as the All-22 (fast, muted, tiny thumbnails). Two
// facts do the work:
//   1. A snap looks the same on every broadcast: the wide game camera (lots of grass on
//      screen) sits still while the teams line up, then starts moving the moment the ball
//      is snapped. That gives a list of candidate snap times, with some misses and extras.
//   2. The replay only cuts out commercial breaks. Between two breaks, the broadcast's time
//      between snaps equals the real time between snaps in the play-by-play. So for each
//      stretch between breaks there is one offset that lines up many plays with candidates
//      at once; chance matches can't do that.
// Only thumbnails are computed, in memory, on this machine; nothing is saved or sent.
/* exported E22Bcast */
var E22Bcast = (function () {
  const BREAK_GAP = 140000; // ms between snaps that means a commercial break
  // Shorter breaks (timeouts, reviews) still cut some time out, so stretches split at this.
  const SPLIT_GAP = 75000;
  const TOL = 0.75; // s: how close a candidate must be to count as that play's snap

  function quantile(xs, q) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }

  // Candidate snaps: the field is on screen, the picture has been still for a moment (teams
  // set, camera waiting), then motion starts and keeps going, with no camera cut in between.
  function findSnaps(frames, { before = 1.5, after = 1.0, gap = 4, minGreen = 0.15, stillMax = 0.0012 } = {}) {
    if (frames.length < 20) return [];
    const out = [];
    let last = -Infinity;
    let a = 0; // start of the "before" window
    let b = 0; // end (exclusive) of the "after" window
    for (let k = 0; k < frames.length; k++) {
      const t = frames[k].t;
      while (a < k && frames[a].t < t - before) a++;
      if (b < k) b = k;
      while (b < frames.length && frames[b].t <= t + after) b++;
      if (t - last < gap || k - a < 3 || b - k < 3) continue;
      if (frames[a].t > t - before + 0.4 || frames[b - 1].t < t + after - 0.4) continue; // scan skipped here
      let pre = 0, post = 0, gPre = 0, ok = true;
      for (let j = a; j < k && ok; j++) {
        const f = frames[j];
        if ((f.green || 0) < minGreen || f.diff > 0.004) ok = false;
        pre += f.diff; gPre += f.green || 0;
      }
      if (!ok) continue;
      pre /= k - a;
      gPre /= k - a;
      if (pre > stillMax) continue;
      for (let j = k; j < b && ok; j++) {
        const f = frames[j];
        if ((f.green || 0) < gPre * 0.6 || f.diff > 0.03) ok = false; // left the field, or a cut
        post += f.diff;
      }
      if (!ok) continue;
      post /= b - k;
      if (post < Math.max(3 * pre, pre + 0.0012)) continue;
      // The snap is the first frame that clearly moves.
      let j = k;
      while (j < b - 1 && frames[j].diff < 2 * pre + 0.0008) j++;
      out.push(frames[j].t);
      last = frames[j].t;
    }
    return out;
  }

  // Stretches of play between commercial breaks.
  function segments(plays) {
    const ps = plays.filter((p) => p.snapAt).sort((x, y) => x.snapAt - y.snapAt);
    const segs = [];
    let cur = [];
    for (let k = 0; k < ps.length; k++) {
      if (k && ps[k].snapAt - ps[k - 1].snapAt > SPLIT_GAP) { segs.push(cur); cur = []; }
      cur.push(ps[k]);
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function nearest(sorted, x) {
    let lo = 0, hi = sorted.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1; else hi = mid;
    }
    let best = sorted[lo];
    if (lo > 0 && Math.abs(sorted[lo - 1] - x) < Math.abs(best - x)) best = sorted[lo - 1];
    return best;
  }

  function refine(rel, cands, o, wts = null) {
    for (let it = 0; it < 2; it++) {
      const res = [];
      for (const r of rel) {
        const c = nearest(cands, o + r);
        if (c != null && Math.abs(c - (o + r)) <= TOL) res.push(c - (o + r));
      }
      if (!res.length) break;
      o += quantile(res, 0.5);
    }
    // late: plays whose nearest snap comes a little after where this offset puts them. The
    // replay only removes time, so within a stretch a snap can come early (a short cut) but
    // not late; several of those mean the offset is probably wrong.
    let matched = 0, weight = 0, last = -1, late = 0;
    rel.forEach((r, i) => {
      const c = nearest(cands, o + r);
      if (c == null) return;
      const d = c - (o + r);
      if (Math.abs(d) <= TOL) { matched++; weight += wts ? wts[i] : 1; last = i; }
      else if (d > 1.5 && d < 6) late++;
    });
    return { o, matched, weight, last, late };
  }

  // Possible offsets (broadcast seconds of the segment's first snap) within [lo, hi], best
  // first: up to `max` distinct ones, each refined, with how many plays line up there.
  function fitsFor(seg, cands, lo, hi, max = 6) {
    const rel = seg.map((p) => (p.snapAt - seg[0].snapAt) / 1000);
    // A kickoff's logged time is loose and its camera doesn't settle like a snap, so a
    // kickoff lining up counts for half.
    const wts = seg.map((p) => (p.type === 'kickoff' ? 0.5 : 1));
    const votes = [];
    for (const c of cands) {
      for (let i = 0; i < rel.length; i++) {
        const o = c - rel[i];
        if (o >= lo && o <= hi) votes.push(o);
      }
    }
    if (!votes.length) return [];
    votes.sort((x, y) => x - y);
    // Every 1.5 s window of votes is a possible offset. The busiest window can be a near miss
    // (plays spaced alike can line up loosely at the wrong offset), so several are refined.
    const peaks = [];
    let j = 0;
    for (let i = 0; i < votes.length; i++) {
      while (votes[i] - votes[j] > 2 * TOL) j++;
      peaks.push({ n: i - j + 1, o: (votes[i] + votes[j]) / 2 });
    }
    peaks.sort((x, y) => y.n - x.n);
    const out = [];
    for (const pk of peaks) {
      if (out.length >= max) break;
      if (out.some((f) => Math.abs(f.o - pk.o) < 2 * TOL)) continue;
      const r = refine(rel, cands, pk.o, wts);
      if (out.some((f) => Math.abs(f.o - r.o) < 2 * TOL)) continue;
      out.push({ ...r, plays: rel.length, span: rel[rel.length - 1] });
    }
    return out.sort((x, y) => y.weight - x.weight || x.late - y.late);
  }
  function fitSegment(seg, cands, lo, hi) {
    return fitsFor(seg, cands, lo, hi)[0] || null;
  }

  // frames + plays -> anchors [{ w, b, auto }] (one per stretch between breaks) and a summary.
  function build(frames, plays, { duration } = {}) {
    const cands = findSnaps(frames);
    const segs = segments(plays);
    const end = duration || (frames.length ? frames[frames.length - 1].t : 0);
    const anchors = [];
    const detail = [];
    let found = 0;
    // A placed stretch can still hide a short cut (a review, an injury stop). Plays after the
    // last one that lined up get their own fit, in the window the cut allows; repeat.
    const place = (seg, fit) => {
      anchors.push({ w: seg[0].snapAt, b: +fit.o.toFixed(3), auto: true });
      found += fit.matched;
      let at = { endB: fit.o + (seg[fit.last].snapAt - seg[0].snapAt) / 1000, endW: seg[fit.last].snapAt };
      let rest = seg.slice(fit.last + 1);
      while (rest.length >= 2) {
        const lo = at.endB + 3;
        const hi = at.endB + (rest[0].snapAt - at.endW) / 1000 + 3;
        const f = fitSegment(rest, cands, lo, hi);
        if (!f || f.matched < Math.max(2, Math.ceil(rest.length * 0.4))) break;
        // Only worth an anchor if it really moved from where the stretch's own fit puts it.
        const before = anchors[anchors.length - 1];
        const predicted = before.b + (rest[0].snapAt - before.w) / 1000;
        if (Math.abs(f.o - predicted) > 2 * TOL) anchors.push({ w: rest[0].snapAt, b: +f.o.toFixed(3), auto: true, cut: true });
        found += f.matched;
        at = { endB: f.o + (rest[f.last].snapAt - rest[0].snapAt) / 1000, endW: rest[f.last].snapAt };
        rest = rest.slice(f.last + 1);
      }
      return at;
    };
    // Place all stretches together. Each has a few possible offsets; a choice must keep the
    // stretches in order, and since the replay only removes time, the broadcast gap after a
    // stretch's last matched snap can't be longer than the real one. Among the choices that
    // fit, the one where the most snaps line up wins. Chance matches rarely survive this,
    // because a wrong offset for one stretch squeezes out its neighbors.
    const rels = segs.map((seg) => seg.map((p) => (p.snapAt - seg[0].snapAt) / 1000));
    const nodes = []; // { k, f, endB, endW, score }
    segs.forEach((seg, k) => {
      for (const f of fitsFor(seg, cands, 0, end, 150)) {
        if (f.matched < 2) continue;
        nodes.push({ k, f, endB: f.o + rels[k][f.last], endW: seg[f.last].snapAt, score: f.weight - 1.2 - 0.3 * f.late });
      }
    });
    nodes.sort((x, y) => x.k - y.k || x.f.o - y.f.o);
    const best = nodes.map(() => ({ v: 0, from: -1 }));
    for (let x = 0; x < nodes.length; x++) {
      const nx = nodes[x];
      let v = nx.score, from = -1;
      if (nx.f.o < 0) { best[x] = { v: -Infinity, from: -1 }; continue; }
      for (let y = 0; y < x; y++) {
        const ny = nodes[y];
        if (ny.k >= nx.k || best[y].v === -Infinity) continue;
        if (nx.f.o < ny.endB + 3) continue;
        if (nx.f.o > ny.endB + (segs[nx.k][0].snapAt - ny.endW) / 1000 + 8) continue;
        if (best[y].v + nx.score > v) { v = best[y].v + nx.score; from = y; }
      }
      best[x] = { v, from };
    }
    let top = -1;
    for (let x = 0; x < nodes.length; x++) if (best[x].v > 0 && (top < 0 || best[x].v > best[top].v)) top = x;
    const chosen = new Map();
    for (let x = top; x >= 0; x = best[x].from) chosen.set(nodes[x].k, nodes[x]);
    // A short stretch left out sits between two placed ones, which pins it into a narrow
    // window; there one matching snap is enough.
    const chosenK = [...chosen.keys()].sort((x, y) => x - y);
    segs.forEach((seg, k) => {
      if (chosen.has(k)) return;
      const p = chosenK.filter((x) => x < k).pop();
      const q = chosenK.find((x) => x > k);
      if (p == null || q == null) return;
      const P = chosen.get(p), Q = chosen.get(q);
      const lo = P.endB + 3;
      const hi = Math.min(P.endB + (seg[0].snapAt - P.endW) / 1000 + 8, Q.f.o - rels[k][rels[k].length - 1] - 3);
      if (hi < lo) return;
      // Accept the only offset in the window where a play lines up.
      const fs = fitsFor(seg, cands, lo, hi, 20).filter((f) => f.weight >= 1 && f.late === 0);
      if (fs.length === 1) chosen.set(k, { f: fs[0], narrow: true });
    });
    segs.forEach((seg, k) => {
      const n = chosen.get(k);
      const d = { first: seg[0].id, plays: seg.length, matched: n ? n.f.matched : 0, offset: n ? +n.f.o.toFixed(2) : null, ok: !!n };
      if (n && n.narrow) d.narrow = true;
      if (n) d.endB = place(seg, n.f).endB;
      detail.push(d);
    });
    anchors.sort((x, y) => x.w - y.w);
    return {
      anchors,
      summary: { candidates: cands.length, segments: segs.length, placed: anchors.length, playsMatched: found, plays: segs.reduce((n, s) => n + s.length, 0) },
      detail,
    };
  }

  return { findSnaps, segments, fitSegment, fitsFor, build, BREAK_GAP, SPLIT_GAP };
})();
if (typeof module !== 'undefined') module.exports = E22Bcast;
