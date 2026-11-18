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
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        luma[y * W + x] = l;
        sum += l;
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
    return { grid, horiz: sy / (sx + sy + 1e-9), luma: sum / (W * H) };
  }

  function gridDiff(a, b) {
    let d = 0;
    for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
    return d / a.length;
  }

  // ---------- scanning ----------
  // Plays the video fast and muted, sampling every displayed frame. Resolves with frames
  // [{ t, diff, horiz, luma }]. Restores the player's state afterwards.
  async function scan(video, { onProgress, shouldStop, rate = 16, startAt = 0 } = {}) {
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
      frames.push({ t, diff: prev ? gridDiff(prev.grid, f.grid) : 0, horiz: f.horiz, luma: f.luma });
      prev = f;
    };

    video.muted = true;
    video.currentTime = startAt;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    video.playbackRate = rate;
    await video.play();

    await new Promise((resolve) => {
      const useRvfc = typeof video.requestVideoFrameCallback === 'function';
      let lastT = -1;
      const done = () => resolve();
      const step = (_now, meta) => {
        if (shouldStop?.()) return done();
        const t = meta ? meta.mediaTime : video.currentTime;
        if (t !== lastT) { sample(t); lastT = t; }
        onProgress?.(Math.min(1, t / (video.duration || 1)));
        if (video.ended || (video.duration && t >= video.duration - 0.5)) return done();
        if (video.paused && !video.ended) video.play().catch(() => {}); // keep going if the player paused itself
        if (useRvfc) video.requestVideoFrameCallback(step);
        else setTimeout(() => step(), 40);
      };
      if (useRvfc) video.requestVideoFrameCallback(step); else step();
    });

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

  // Label shots sideline ('S') or end zone ('E'). Primary signal: line orientation relative
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
  const PRE_SNAP = /False Start|Delay of Game|Encroachment|Neutral Zone Infraction|Illegal Substitution|Too Many Men|Illegal Shift|Defensive Offside|Offside on Free Kick/i;

  function playDuration(p) {
    return p.snapAt && p.endAt && p.endAt > p.snapAt ? (p.endAt - p.snapAt) / 1000 : null;
  }

  // Needleman-Wunsch style alignment of film clips to play-by-play rows.
  // With openEnd (a scan that stopped partway), plays after the last clip cost nothing to skip.
  function align(clips, plays, { openEnd = false } = {}) {
    const n = clips.length, m = plays.length;
    const durs = plays.map(playDuration);
    const known = durs.filter((d) => d != null);
    const pad = median(clips.map((c) => c.dur)) - median(known.length ? known : [5]);
    const SKIP_CLIP = 2.0;
    const skipPlay = plays.map((p) => (p.type === 'no_play' && PRE_SNAP.test(p.desc || '') ? 0.1 : 1.2));
    const matchCost = (i, j) => {
      const d = durs[j];
      const base = d == null ? 0.6 : Math.min(2, Math.abs(clips[i].dur - (d + pad)) / 4);
      const pre = plays[j].type === 'no_play' && PRE_SNAP.test(plays[j].desc || '') ? 0.8 : 0;
      return base + pre;
    };
    const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 match, 2 skip clip, 3 skip play
    for (let i = 1; i <= n; i++) { D[i][0] = D[i - 1][0] + SKIP_CLIP; B[i][0] = 2; }
    for (let j = 1; j <= m; j++) { D[0][j] = D[0][j - 1] + skipPlay[j - 1]; B[0][j] = 3; }
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const a = D[i - 1][j - 1] + matchCost(i - 1, j - 1);
        const b = D[i - 1][j] + SKIP_CLIP;
        const c = D[i][j - 1] + skipPlay[j - 1];
        if (a <= b && a <= c) { D[i][j] = a; B[i][j] = 1; }
        else if (b <= c) { D[i][j] = b; B[i][j] = 2; }
        else { D[i][j] = c; B[i][j] = 3; }
      }
    }
    const matches = new Map(); // play index -> clip index
    let i = n, j = m;
    if (openEnd) {
      for (let jj = 0; jj <= m; jj++) if (D[n][jj] < D[n][j]) j = jj;
    }
    const lastPlay = j - 1;
    while (i > 0 || j > 0) {
      const b = B[i][j];
      if (b === 1) { matches.set(j - 1, i - 1); i--; j--; }
      else if (b === 2) i--;
      else j--;
    }
    return { matches, pad, lastPlay };
  }

  // Full pipeline: frames + plays -> marks { playId: { s, e, auto } | { skip, auto } } and a summary.
  // partial: the scan covered only the start of the video, so plays past the last clip found
  // are left unsynced instead of being marked missing.
  function build(frames, plays, { partial = false } = {}) {
    const shots = labelShots(findShots(frames));
    let clips = clipsFrom(shots);
    // In a partial scan the last sideline clip may be cut off; drop it so it is redone on resume.
    if (partial && clips.length && shots.length && shots[shots.length - 1].label === 'S') clips = clips.slice(0, -1);
    const { matches, pad, lastPlay } = align(clips, plays, { openEnd: partial });
    const marks = {};
    plays.forEach((p, j) => {
      if (partial && j > lastPlay) return;
      const c = matches.has(j) ? clips[matches.get(j)] : null;
      marks[p.id] = c ? { s: c.s, e: c.e, auto: true } : { skip: true, auto: true };
    });
    const alternating = shots.slice(1).filter((x, k) => x.label !== shots[k].label).length / Math.max(1, shots.length - 1);
    return {
      marks,
      summary: { shots: shots.length, clips: clips.length, matched: matches.size, plays: plays.length, pad, alternating },
    };
  }

  return { W, H, features, gridDiff, scan, findShots, labelShots, clipsFrom, align, build };
})();
if (typeof module !== 'undefined') module.exports = E22Auto;
