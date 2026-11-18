// Automatic play sync for All-22 replays.
//
// The All-22 replay is one continuous video in which every play appears twice: first the
// sideline angle, then the end zone angle, separated by hard camera cuts. We fast-forward
// through the video (muted), take a tiny 96x54 thumbnail of each displayed frame, and:
//   1. find hard cuts (big jumps in a coarse color grid between consecutive thumbnails),
//   2. tell sideline from end zone shots by line orientation (yard lines run up-and-down the
//      screen from the sideline, and across the screen from the end zone),
//   3. line the sideline clips up with the play-by-play using each play's real duration.
// Only thumbnails are computed, in memory, on this machine; nothing is saved or sent.
/* exported E22Auto */
var E22Auto = (function () {
  const W = 96;
  const H = 54;
  const GX = 8;
  const GY = 6;

  // ---------- per-frame features ----------
  function features(data) {
    // data: RGBA Uint8ClampedArray of W*H
    const grid = new Float32Array(GX * GY * 3);
    const cellW = W / GX;
    const cellH = H / GY;
    const luma = new Float32Array(W * H);
    let sum = 0;
    let green = 0; // share of grass-colored pixels (high in a broadcast's wide game shot)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        luma[y * W + x] = l;
        sum += l;
        if (g > 0.15 && g > r * 1.12 && g > b * 1.12) green++;
        const c = (Math.floor(y / cellH) * GX + Math.floor(x / cellW)) * 3;
        grid[c] += r; grid[c + 1] += g; grid[c + 2] += b;
      }
    }
    const n = cellW * cellH;
    for (let k = 0; k < grid.length; k++) grid[k] /= n;
    // Edge orientation (Sobel). Strong horizontal edges => large |gy|.
    let sx = 0, sy = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = (yy, xx) => luma[yy * W + xx];
        const gx = p(y - 1, x + 1) + 2 * p(y, x + 1) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y, x - 1) - p(y + 1, x - 1);
        const gy = p(y + 1, x - 1) + 2 * p(y + 1, x) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y - 1, x) - p(y - 1, x + 1);
        sx += Math.abs(gx); sy += Math.abs(gy);
      }
    }
    return { grid, horiz: sy / (sx + sy + 1e-9), luma: sum / (W * H), green: green / (W * H) };
  }

  function gridDiff(a, b) {
    let d = 0;
    for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
    return d / a.length;
  }

  // ---------- scanning ----------
  // Plays the video fast and muted, sampling every displayed frame. Resolves with frames
  // [{ t, diff, horiz, luma }]. Restores the player's state afterwards.
  async function scan(video, { onProgress, shouldStop, rate = 8, startAt = 0 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const saved = { t: video.currentTime, rate: video.playbackRate, muted: video.muted, paused: video.paused };
    const frames = [];
    let prev = null;

    // Fail early, with a clear message, if the browser won't let us read frames.
    ctx.drawImage(video, 0, 0, W, H);
    try { ctx.getImageData(0, 0, 1, 1); } catch {
      throw new Error('This player does not allow reading video frames, so automatic sync cannot work here.');
    }

    const sample = (t) => {
      ctx.drawImage(video, 0, 0, W, H);
      const f = features(ctx.getImageData(0, 0, W, H).data);
      frames.push({ t, diff: prev ? gridDiff(prev.grid, f.grid) : 0, horiz: f.horiz, luma: f.luma, green: f.green });
      prev = f;
    };

    video.muted = true;
    video.currentTime = startAt;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    const maxRate = rate;
    video.playbackRate = rate;
    await video.play();

    // Chrome can't draw every frame at high speed (busy machine, slow network, or the tab in
    // the background), and the frames it drops are often right at the camera cuts we need.
    // When the scan jumps over more than GAP seconds, go back and replay that stretch slower;
    // speed back up after a clean stretch. While the tab is hidden, pause instead of skipping.
    const GAP = 0.6;
    const onVis = () => {
      if (document.hidden) video.pause();
      else video.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    try {
      await new Promise((resolve) => {
        const useRvfc = typeof video.requestVideoFrameCallback === 'function';
        let lastT = -1;
        let retries = 0;
        let retryFrom = -1;
        let calmSince = startAt;
        const done = () => resolve();
        const next = () => { if (useRvfc) video.requestVideoFrameCallback(step); else setTimeout(() => step(), 40); };
        const step = (_now, meta) => {
          if (shouldStop?.()) return done();
          if (document.hidden || video.seeking) return next();
          const t = meta ? meta.mediaTime : video.currentTime;
          if (lastT >= 0 && t - lastT > GAP) {
            if (Math.abs(lastT - retryFrom) > 0.05) { retryFrom = lastT; retries = 0; }
          }
          if (lastT >= 0 && t - lastT > GAP && retries < 3) {
            retries++;
            rate = Math.max(1, rate / 2);
            video.playbackRate = rate;
            video.currentTime = lastT + 0.01;
            calmSince = lastT;
            return next();
          }
          if (t > lastT) { sample(t); lastT = t; } // after 3 tries, accept the gap and move on
          if (rate < maxRate && t - calmSince > 15) { rate = Math.min(maxRate, rate * 2); video.playbackRate = rate; calmSince = t; }
          onProgress?.(Math.min(1, t / (video.duration || 1)));
          if (video.ended || (video.duration && t >= video.duration - 0.5)) return done();
          if (video.paused && !video.ended) video.play().catch(() => {}); // keep going if the player paused itself
          next();
        };
        next();
      });
    } finally {
      document.removeEventListener('visibilitychange', onVis);
    }

    video.pause();
    video.playbackRate = saved.rate;
    video.muted = saved.muted;
    video.currentTime = saved.t;
    if (!saved.paused) video.play().catch(() => {});
    return frames;
  }

  // ---------- cuts and shots ----------
  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function findShots(frames, { minShot = 1.2 } = {}) {
    if (frames.length < 3) return [];
    const cuts = [frames[0].t];
    const win = 12;
    for (let k = 1; k < frames.length; k++) {
      const lo = Math.max(1, k - win), hi = Math.min(frames.length, k + win + 1);
      const around = [];
      for (let j = lo; j < hi; j++) if (j !== k) around.push(frames[j].diff);
      const med = median(around);
      const d = frames[k].diff;
      const darkEdge = (frames[k].luma < 0.05) !== (frames[k - 1].luma < 0.05);
      const turn = Math.abs(frames[k].horiz - frames[k - 1].horiz) > 0.15; // line direction flipped
      if ((d > 0.025 && d > 5 * med + 0.004) || darkEdge || (turn && d > 2 * med + 0.004)) {
        if (frames[k].t - cuts[cuts.length - 1] >= minShot) cuts.push(frames[k].t);
      }
    }
    const end = frames[frames.length - 1].t;
    const shots = [];
    for (let c = 0; c < cuts.length; c++) {
      const s = cuts[c];
      const e = c + 1 < cuts.length ? cuts[c + 1] : end;
      const inShot = frames.filter((f) => f.t >= s && f.t < e);
      if (!inShot.length) continue;
      const dark = median(inShot.map((f) => f.luma)) < 0.05;
      shots.push({ s, e, dur: e - s, horiz: median(inShot.map((f) => f.horiz)), dark });
    }
    return shots.filter((x) => !x.dark);
  }

  // Primary method (tuned on real All-22 footage): every frame is classified sideline or end
  // zone by its line orientation, which separates cleanly into two clusters. Shots are runs of
  // the same class. This doesn't depend on catching the cut itself, which fast playback often
  // skips over.
  function segmentByAngle(frames, { minRun = 1.5 } = {}) {
    const hs = frames.filter((f) => f.luma >= 0.05).map((f) => f.horiz).sort((a, b) => a - b);
    if (hs.length < 20) return null;
    let lo = hs[Math.floor(hs.length * 0.2)];
    let hi = hs[Math.floor(hs.length * 0.8)];
    for (let it = 0; it < 15; it++) {
      const thr = (lo + hi) / 2;
      const a = hs.filter((h) => h < thr), b = hs.filter((h) => h >= thr);
      if (!a.length || !b.length) break;
      lo = a.reduce((x, y) => x + y, 0) / a.length;
      hi = b.reduce((x, y) => x + y, 0) / b.length;
    }
    if (hi - lo < 0.08) return null; // no clear two-angle structure
    const thr = (lo + hi) / 2;
    const margin = (hi - lo) * 0.15;

    let cur = frames[0].horiz >= thr ? 'E' : 'S';
    let runs = [];
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k];
      if (f.luma >= 0.05) {
        if (cur === 'S' && f.horiz > thr + margin) cur = 'E';
        else if (cur === 'E' && f.horiz < thr - margin) cur = 'S';
      }
      const last = runs[runs.length - 1];
      if (last && last.label === cur) { last.j = k; continue; }
      runs.push({ label: cur, i: k, j: k });
    }
    // Boundary between frame k-1 and k: the middle of any gap the fast scan jumped over.
    // When the change happened inside a gap the scan skipped over, a sideline shot is placed at
    // the start of the gap (better to land a moment early, before the snap, than late).
    const startOf = (r) => {
      if (r.i === 0) return frames[0].t;
      const a = frames[r.i - 1].t, b = frames[r.i].t;
      if (b - a > 0.5) return r.label === 'S' ? a + 0.1 : (a + b) / 2;
      return (a + b) / 2;
    };
    const endOf = (r, next) => (next ? startOf(next) : frames[r.j].t);
    const span = (k) => endOf(runs[k], runs[k + 1]) - startOf(runs[k]);
    // Absorb flickers shorter than minRun into their neighbors.
    for (;;) {
      let worst = -1;
      for (let k = 0; k < runs.length; k++) if (span(k) < minRun && (worst < 0 || span(k) < span(worst))) worst = k;
      if (worst < 0 || runs.length < 2) break;
      const r = runs[worst];
      if (worst > 0) runs[worst - 1].j = r.j; else runs[1].i = r.i;
      runs.splice(worst, 1);
      // merge neighbors that now share a label
      const merged = [];
      for (const x of runs) {
        const last = merged[merged.length - 1];
        if (last && last.label === x.label) last.j = x.j; else merged.push({ ...x });
      }
      runs = merged;
    }
    return runs.map((r, k) => {
      const sT = startOf(r), eT = endOf(r, runs[k + 1]);
      const inRun = frames.slice(r.i, r.j + 1).map((f) => f.horiz);
      return { s: sT, e: eT, dur: eT - sT, horiz: median(inRun), label: r.label, dark: false };
    });
  }

  // Fallback: label cut-based shots sideline ('S') or end zone ('E'). Primary signal: line orientation relative
  // to the game's own median. Where that is ambiguous, fall back to alternation.
  function labelShots(shots) {
    if (!shots.length) return [];
    const med = median(shots.map((x) => x.horiz));
    const spread = median(shots.map((x) => Math.abs(x.horiz - med))) || 0.01;
    const labels = shots.map((x) => {
      const z = (x.horiz - med) / spread;
      return z > 0.5 ? 'E' : z < -0.5 ? 'S' : null;
    });
    for (let k = 0; k < labels.length; k++) {
      if (labels[k]) continue;
      const before = labels[k - 1];
      const after = labels[k + 1];
      labels[k] = before ? (before === 'S' ? 'E' : 'S') : after ? (after === 'S' ? 'E' : 'S') : 'S';
    }
    return shots.map((x, k) => ({ ...x, label: labels[k] }));
  }

  // One film clip per play: a sideline shot, ending where the next end zone shot starts.
  function clipsFrom(labeled) {
    const clips = [];
    for (let k = 0; k < labeled.length; k++) {
      const x = labeled[k];
      if (x.label !== 'S') continue;
      const next = labeled[k + 1];
      const ez = next && next.label === 'E' ? next : null;
      clips.push({ s: x.s, e: x.e, dur: x.dur, ezDur: ez ? ez.dur : null });
    }
    return clips;
  }

  // ---------- matching clips to plays ----------
  // A "no play" that never got snapped (false start, delay of game...): its description goes
  // straight to the penalty, with no run or pass before it. Those are not on film.
  const PRE_SNAP_DESC = /^\([^)]*\)\s*(\([^)]*\)\s*)*PENALTY/i;
  const isPreSnap = (p) => p.type === 'no_play' && PRE_SNAP_DESC.test(p.desc || '');

  // Seconds from the start of the sideline view to the snap: 0.35-0.45 s on clean scans
  // checked against snaps placed by hand.
  const SNAP_LEAD = 0.4;

  function playDuration(p) {
    return p.snapAt && p.endAt && p.endAt > p.snapAt ? (p.endAt - p.snapAt) / 1000 : null;
  }

  // Needleman-Wunsch style alignment of film clips to play-by-play rows.
  // With openEnd (a scan that stopped partway), plays after the last clip cost nothing to skip.
  // fixed: { playIndex: seconds } from plays you placed by hand; they pin the alignment.
  function align(clips, plays, { openEnd = false, fixed = {} } = {}) {
    const n = clips.length, m = plays.length;
    const durs = plays.map(playDuration);
    const known = durs.filter((d) => d != null);
    const pad = median(clips.map((c) => c.dur)) - median(known.length ? known : [5]);
    // Very short sideline-looking clips are usually a camera flip inside a play, not a play.
    const skipClip = clips.map((c) => (c.dur < 4 ? 0.5 : c.dur < 8 ? 1.6 : 2.2));
    // Kicks: the camera follows the ball downfield, so the angle flips more than once and one
    // kickoff or punt can show up as two sideline-looking clips. Let a kick take two clips.
    const isKick = plays.map((p) => p.type === 'kickoff' || p.type === 'punt');
    const skipPlay = plays.map((p) => (isPreSnap(p) ? 0.1 : 1.6));
    const fixedAt = Object.entries(fixed).map(([j, t]) => [Number(j), t]);
    for (const [j] of fixedAt) if (j < skipPlay.length) skipPlay[j] = 10;
    const NEAR_FIX = 4;
    // dur: the film length to compare with the play (a kick spread over several clips passes
    // the whole span, from its first sideline clip to the end of its last).
    const matchCost = (i, j, dur = clips[i].dur) => {
      if (j in fixed) return Math.abs(clips[i].s - fixed[j]) < NEAR_FIX ? -10 : 10;
      if (fixedAt.some(([, t]) => Math.abs(clips[i].s - t) < NEAR_FIX)) return 10;
      const d = durs[j];
      const base = d == null ? 0.4 : Math.min(1.2, Math.abs(dur - (d + pad)) / 8);
      const pre = isPreSnap(plays[j]) ? 0.8 : 0;
      return base + pre;
    };
    const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 match, 2 skip clip, 3 skip play, 4 kick over two clips
    for (let i = 1; i <= n; i++) { D[i][0] = D[i - 1][0] + skipClip[i - 1]; B[i][0] = 2; }
    for (let j = 1; j <= m; j++) { D[0][j] = D[0][j - 1] + skipPlay[j - 1]; B[0][j] = 3; }
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const a = D[i - 1][j - 1] + matchCost(i - 1, j - 1);
        const b = D[i - 1][j] + skipClip[i - 1];
        const c = D[i][j - 1] + skipPlay[j - 1];
        // A kick's follow-up clips (the camera turning to follow the return) are short. The
        // whole span is compared with the kick's length, so a kick can't swallow a real play
        // (say, the field goal before it) just to absorb clips.
        const tail = (x) => (clips[x].dur < 8 ? -0.2 : 0.4);
        const span = (a, b) => clips[b].e - clips[a].s;
        const pinned = (x) => fixedAt.some(([jj, t]) => jj !== j - 1 && Math.abs(clips[x].s - t) < NEAR_FIX);
        const k = isKick[j - 1] && i >= 2 && !pinned(i - 1)
          ? D[i - 2][j - 1] + matchCost(i - 2, j - 1, span(i - 2, i - 1)) + tail(i - 1) : Infinity;
        const k3 = isKick[j - 1] && i >= 3 && clips[i - 1].dur < 4 && !pinned(i - 1) && !pinned(i - 2)
          ? D[i - 3][j - 1] + matchCost(i - 3, j - 1, span(i - 3, i - 1)) + tail(i - 2) + tail(i - 1) : Infinity;
        const best = Math.min(a, b, c, k, k3);
        D[i][j] = best;
        B[i][j] = best === a ? 1 : best === k ? 4 : best === k3 ? 5 : best === b ? 2 : 3;
      }
    }
    const matches = new Map(); // play index -> clip index
    const extended = new Map(); // kick play index -> second clip index
    let i = n, j = m;
    if (openEnd) {
      for (let jj = 0; jj <= m; jj++) if (D[n][jj] < D[n][j]) j = jj;
    }
    const lastPlay = j - 1;
    while (i > 0 || j > 0) {
      const b = B[i][j];
      if (b === 1) { matches.set(j - 1, i - 1); i--; j--; }
      else if (b === 4) { matches.set(j - 1, i - 2); extended.set(j - 1, i - 1); i -= 2; j--; }
      else if (b === 5) { matches.set(j - 1, i - 3); extended.set(j - 1, i - 1); i -= 3; j--; }
      else if (b === 2) i--;
      else j--;
    }
    return { matches, extended, pad, lastPlay };
  }

  // Share of the scanned stretch actually seen (frames no more than 0.6 s apart). Missed
  // stretches tend to hide camera cuts, which is what throws the play matching off.
  function coverage(frames) {
    if (frames.length < 2) return 0;
    let missed = 0;
    for (let k = 1; k < frames.length; k++) {
      const g = frames[k].t - frames[k - 1].t;
      if (g > 0.6) missed += g;
    }
    return 1 - missed / Math.max(1e-9, frames[frames.length - 1].t - frames[0].t);
  }

  // Full pipeline: frames + plays -> marks { playId: { s, e, auto } | { skip, auto } } and a summary.
  // partial: the scan covered only the start of the video, so plays past the last clip found
  // are left unsynced instead of being marked missing.
  function build(frames, plays, { partial = false, fixed = {} } = {}) {
    const shots = segmentByAngle(frames) || labelShots(findShots(frames));
    let clips = clipsFrom(shots);
    // In a partial scan the last sideline clip may be cut off; drop it so it is redone on resume.
    if (partial && clips.length && shots.length && shots[shots.length - 1].label === 'S') clips = clips.slice(0, -1);
    const { matches, extended, pad, lastPlay } = align(clips, plays, { openEnd: partial, fixed });
    const marks = {};
    plays.forEach((p, j) => {
      if (partial && j > lastPlay) return;
      const c = matches.has(j) ? clips[matches.get(j)] : null;
      if (!c) { marks[p.id] = { skip: true, auto: true }; return; }
      const c2 = extended.has(j) ? clips[extended.get(j)] : null;
      if (c2) { marks[p.id] = { s: c.s, e: c2.e, snap: Math.min(c.s + SNAP_LEAD, c.e), auto: true }; return; }
      // The sideline view opens a moment before the snap.
      const snap = Math.min(c.s + SNAP_LEAD, c.e);
      marks[p.id] = { s: c.s, e: c.e, snap, auto: true };
    });
    const alternating = shots.slice(1).filter((x, k) => x.label !== shots[k].label).length / Math.max(1, shots.length - 1);
    return {
      marks,
      detail: {
        shots: shots.map((x) => ({ s: +x.s.toFixed(2), e: +x.e.toFixed(2), label: x.label, horiz: +x.horiz.toFixed(3) })),
        matches: [...matches].map(([j, c]) => [plays[j].id, c]),
      },
      summary: { shots: shots.length, clips: clips.length, matched: matches.size, plays: plays.length, pad, alternating, coverage: coverage(frames) },
    };
  }

  return { W, H, features, gridDiff, scan, segmentByAngle, findShots, labelShots, clipsFrom, align, build, SNAP_LEAD };
})();
if (typeof module !== 'undefined') module.exports = E22Auto;
