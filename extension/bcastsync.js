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
      if (k && ps[k].snapAt - ps[k - 1].snapAt > BREAK_GAP) { segs.push(cur); cur = []; }
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

  // Best offset (broadcast seconds of the segment's first snap) within [lo, hi].
  function fitSegment(seg, cands, lo, hi) {
    const rel = seg.map((p) => (p.snapAt - seg[0].snapAt) / 1000);
    const votes = [];
    for (const c of cands) {
      for (let i = 0; i < rel.length; i++) {
        const o = c - rel[i];
        if (o >= lo && o <= hi) votes.push(o);
      }
    }
    if (!votes.length) return null;
    votes.sort((x, y) => x - y);
    let best = null;
    let j = 0;
    for (let i = 0; i < votes.length; i++) {
      while (votes[i] - votes[j] > 2 * TOL) j++;
      const n = i - j + 1;
      if (!best || n > best.n) best = { n, o: (votes[i] + votes[j]) / 2 };
    }
    // Refine: median residual of the plays that matched.
    let o = best.o;
    for (let it = 0; it < 2; it++) {
      const res = [];
      for (const r of rel) {
        const c = nearest(cands, o + r);
        if (c != null && Math.abs(c - (o + r)) <= TOL) res.push(c - (o + r));
      }
      if (!res.length) break;
      o += quantile(res, 0.5);
    }
    let matched = 0;
    for (const r of rel) {
      const c = nearest(cands, o + r);
      if (c != null && Math.abs(c - (o + r)) <= TOL) matched++;
    }
    return { o, matched, plays: rel.length, span: rel[rel.length - 1] };
  }

  // frames + plays -> anchors [{ w, b, auto }] (one per stretch between breaks) and a summary.
  function build(frames, plays, { duration } = {}) {
    const cands = findSnaps(frames);
    const segs = segments(plays);
    const end = duration || (frames.length ? frames[frames.length - 1].t : 0);
    const anchors = [];
    const detail = [];
    let prev = null; // { endB, endW }
    let found = 0;
    for (const seg of segs) {
      let lo = 0, hi = end;
      if (prev) {
        lo = prev.endB + 5;
        hi = lo + (seg[0].snapAt - prev.endW) / 1000 + 30;
      }
      const fit = fitSegment(seg, cands, lo, hi);
      // At least 3 plays (and 40% of the stretch) must line up; short stretches are left to
      // the break estimate rather than risk a chance match.
      const ok = !!fit && seg.length >= 3 && fit.matched >= Math.max(3, Math.ceil(seg.length * 0.4));
      detail.push({ first: seg[0].id, plays: seg.length, matched: fit ? fit.matched : 0, offset: fit ? +fit.o.toFixed(2) : null, ok });
      if (ok) {
        anchors.push({ w: seg[0].snapAt, b: +fit.o.toFixed(3), auto: true });
        found += fit.matched;
        prev = { endB: fit.o + fit.span, endW: seg[seg.length - 1].snapAt };
      } else if (prev) {
        // Unplaced stretch: carry the search window forward past it.
        prev = { endB: prev.endB, endW: prev.endW };
      }
    }
    // Second pass: a stretch left unplaced sits between two placed ones, which pins it into a
    // narrow window (after the previous stretch, early enough for the next one to fit). Inside
    // that window two matching snaps are enough.
    const fits = segs.map((seg, k) => (detail[k].ok ? { o: detail[k].offset, span: (seg[seg.length - 1].snapAt - seg[0].snapAt) / 1000 } : null));
    for (let k = 0; k < segs.length; k++) {
      if (fits[k]) continue;
      const seg = segs[k];
      let p = k - 1; while (p >= 0 && !fits[p]) p--;
      let q = k + 1; while (q < segs.length && !fits[q]) q++;
      if (p < 0 || q >= segs.length) continue;
      const span = (seg[seg.length - 1].snapAt - seg[0].snapAt) / 1000;
      const lo = fits[p].o + fits[p].span + 5;
      const hi = fits[q].o - span - 5;
      if (hi < lo) continue;
      const fit = fitSegment(seg, cands, lo, hi);
      if (fit && fit.matched >= Math.min(2, seg.length) && fit.matched >= Math.ceil(seg.length * 0.3)) {
        fits[k] = { o: fit.o, span };
        anchors.push({ w: seg[0].snapAt, b: +fit.o.toFixed(3), auto: true });
        found += fit.matched;
        Object.assign(detail[k], { matched: fit.matched, offset: +fit.o.toFixed(2), ok: true, narrow: true });
      }
    }
    anchors.sort((x, y) => x.w - y.w);
    return {
      anchors,
      summary: { candidates: cands.length, segments: segs.length, placed: anchors.length, playsMatched: found, plays: segs.reduce((n, s) => n + s.length, 0) },
      detail,
    };
  }

  return { findSnaps, segments, fitSegment, build, BREAK_GAP };
})();
if (typeof module !== 'undefined') module.exports = E22Bcast;
