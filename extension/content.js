// Enhanced22 overlay: runs inside NFL+ pages, finds the replay <video>, and draws
// game context + a play list on top of it. It only reads currentTime / seeks the
// player like any user would; it never touches the video data itself.
(() => {
  if (window.__enhanced22) return;
  window.__enhanced22 = true;

  const NEAR = 0.05; // seconds of slack when matching time to a play start

  const state = {
    video: null,
    game: null, // { gameId, home, away, week, ... }
    plays: [],
    marks: {}, // playId -> { s, e } | { skip: true }
    history: [], // playIds in the order they were marked (for undo)
    prefs: { overlay: true, list: true, autoSkip: false, broadcastAudio: true },
    audioOffset: 0, // seconds; nudged with [ and ]
    anchors: [], // broadcast audio sync points: { w: snap wall-clock ms, b: broadcast video seconds }
    isAudioTab: false,
    lastDrive: null, // latest message from the All-22 tab (audio tab only)
    suppressSkipFor: null, // play index the user deliberately seeked into the end zone view of
    internalSeek: false,
  };

  // ---------- extension lifetime ----------
  // When the extension is reloaded or updated, this copy of the script is orphaned and every
  // chrome.* call throws "Extension context invalidated". Detect that and shut down quietly.
  let dead = false;
  const timers = [];
  const alive = () => { try { return !dead && !!chrome.runtime?.id; } catch { return false; } };
  function shutdown() {
    if (dead) return;
    dead = true;
    timers.forEach(clearInterval);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('fullscreenchange', placeHost);
    host?.remove();
    window.__enhanced22 = false; // a fresh copy (after a page refresh) may take over
  }
  function send(msg) {
    if (!alive()) { shutdown(); return Promise.resolve(null); }
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { shutdown(); return Promise.resolve(null); }
  }
  function storeSet(obj) {
    if (!alive()) { shutdown(); return Promise.resolve(); }
    try { return chrome.storage.local.set(obj).catch(() => {}); } catch { shutdown(); return Promise.resolve(); }
  }
  async function storeGet(keys) {
    if (!alive()) { shutdown(); return {}; }
    try { return await chrome.storage.local.get(keys); } catch { shutdown(); return {}; }
  }

  // ---------- storage ----------
  const marksKey = () => `marks:${state.game.gameId}`;

  async function loadActiveGame() {
    const { activeGame, prefs } = await storeGet(['activeGame', 'prefs']);
    if (prefs) state.prefs = { ...state.prefs, ...prefs };
    if (!activeGame) { state.game = null; state.plays = []; renderList(); render(); return; }
    const pk = `plays:${activeGame.gameId}`;
    const mk = `marks:${activeGame.gameId}`;
    const data = await storeGet([pk, mk]);
    state.game = activeGame;
    state.plays = data[pk] || [];
    // Plays saved by an older version lack player names and yards: fetch the season again.
    if (state.plays.length && state.plays[0].yards === undefined && !loadActiveGame.refetched) {
      loadActiveGame.refetched = true;
      const season = Number(String(activeGame.gameId).slice(0, 4));
      send({ type: 'getGames', season, refresh: true }).then(() => loadActiveGame());
    }
    const saved = data[mk] || {};
    state.marks = saved.marks || {};
    state.history = saved.history || [];
    state.anchors = saved.anchors || [];
    state.audioOffset = saved.audioOffset || 0;
    renderList();
    renderAutoButton();
    render();
  }

  function saveMarks() {
    storeSet({
      [marksKey()]: { marks: state.marks, history: state.history, anchors: state.anchors, audioOffset: state.audioOffset },
    });
  }

  function savePrefs() {
    storeSet({ prefs: state.prefs });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.activeGame) { loadActiveGame(); return; }
    if (changes.prefs) { state.prefs = { ...state.prefs, ...(changes.prefs.newValue || {}) }; render(); }
    if (state.game && changes[marksKey()]) {
      const v = changes[marksKey()].newValue || {};
      state.marks = v.marks || {};
      state.history = v.history || [];
      state.anchors = v.anchors || [];
      state.audioOffset = v.audioOffset || 0;
      renderList();
      render();
    }
  });

  // ---------- sync model ----------
  const markOf = (i) => state.marks[state.plays[i]?.id];
  const hasStart = (i) => typeof markOf(i)?.s === 'number';

  function nextUnsyncedIndex() {
    let last = -1;
    state.plays.forEach((p, i) => { if (state.marks[p.id]) last = i; });
    return last + 1 < state.plays.length ? last + 1 : -1;
  }

  function segment(i) {
    const m = markOf(i);
    if (!m || typeof m.s !== 'number') return null;
    let next = null;
    for (let j = i + 1; j < state.plays.length; j++) {
      if (hasStart(j)) { next = markOf(j).s; break; }
    }
    let end = typeof m.e === 'number' ? m.e : null;
    if (end == null && next != null) end = m.s + (next - m.s) / 2; // end zone view ≈ same length
    return { s: m.s, end, next };
  }

  function currentIndex(t) {
    let best = -1;
    let bestS = -Infinity;
    state.plays.forEach((p, i) => {
      const m = state.marks[p.id];
      if (m && typeof m.s === 'number' && m.s <= t + NEAR && m.s >= bestS) { best = i; bestS = m.s; }
    });
    return best;
  }

  // Every jump the extension makes goes through here and says why on screen, so a jump with
  // no message didn't come from Enhanced22.
  function seek(t, reason) {
    if (!state.video) return;
    console.info('[Enhanced22] seek', reason, state.video.currentTime, '->', t);
    toast(`Enhanced22 jumped (${reason}): ${fmtTime(state.video.currentTime)} → ${fmtTime(t)}`);
    state.internalSeek = true;
    state.video.currentTime = Math.max(0, t);
  }

  function syncedCount() {
    return state.plays.filter((p) => typeof state.marks[p.id]?.s === 'number').length;
  }

  // ---------- actions ----------
  function markNext() {
    const i = nextUnsyncedIndex();
    if (i < 0) return toast('Every play is already synced');
    const t = state.video.currentTime;
    const prev = currentIndex(t + 1e6);
    if (prev >= 0 && markOf(prev).s > t) {
      return toast('That is earlier than the last synced play. Press Z to undo first.');
    }
    const p = state.plays[i];
    state.marks[p.id] = { s: t };
    state.history.push(p.id);
    saveMarks();
    toast(`Synced: ${E22.quarter(p.qtr)} ${E22.clock(p.time)} ${E22.typeLabel(p)}`);
  }

  function skipNext() {
    const i = nextUnsyncedIndex();
    if (i < 0) return;
    const p = state.plays[i];
    state.marks[p.id] = { skip: true };
    state.history.push(p.id);
    saveMarks();
    toast(`Skipped (not in replay): ${E22.quarter(p.qtr)} ${E22.clock(p.time)} ${E22.typeLabel(p)}`);
  }

  function undo() {
    const id = state.history.pop();
    if (!id) return toast('Nothing to undo');
    delete state.marks[id];
    saveMarks();
    toast('Undid last sync');
  }

  function markSidelineEnd() {
    const t = state.video.currentTime;
    const i = currentIndex(t);
    if (i < 0) return;
    const m = markOf(i);
    if (t <= m.s) return;
    m.e = t;
    saveMarks();
    toast('Set end of sideline view for this play');
  }

  function jump(delta) {
    const t = state.video.currentTime;
    const synced = [];
    state.plays.forEach((p, i) => { if (hasStart(i)) synced.push(i); });
    if (!synced.length) return;
    const cur = currentIndex(t);
    let pos = synced.indexOf(cur);
    if (delta < 0 && cur >= 0 && t - markOf(cur).s > 2) pos += 1; // first "prev" restarts current play
    const target = synced[Math.min(synced.length - 1, Math.max(0, pos + delta))];
    if (target != null) seek(markOf(target).s, delta > 0 ? 'Next play' : 'Previous play');
  }

  // ---------- skipping the end zone view ----------
  function tick() {
    const v = state.video;
    if (!v) return;
    if (!state.game || state.scanning) { renderStatus(v.currentTime, v); return; }
    const t = v.currentTime;
    const i = currentIndex(t);
    if (state.prefs.autoSkip && !v.paused && i >= 0 && state.suppressSkipFor !== i &&
        performance.now() > skipCooldownUntil) {
      const seg = segment(i);
      // Only skip a real end zone view: the clip must be long enough to hold two angles, and we
      // must be well short of the next play (streams often land a second or two early on a seek).
      if (seg && seg.end != null && seg.next != null && seg.next - seg.s >= 6 &&
          t >= seg.end && seg.next - t > 1.5) {
        autoSkip(seg, t);
      }
    }
    if (!state.isAudioTab) { renderBug(i); renderStatus(t, v); }
    driveAudio(i, t);
  }

  // ---------- broadcast audio ----------
  // The All-22 tab knows which play is on screen and how far into it we are. Each play's
  // snap has a wall-clock time in the play-by-play data, so "seconds since the snap" maps
  // to a wall-clock moment, and anchors map wall-clock moments onto the broadcast replay.
  let lastDriveSent = 0;
  let lastDriveKey = '';
  // Wall-clock moment for All-22 time t inside play i (null if unknown).
  function wallFor(i, t) {
    const p = i >= 0 ? state.plays[i] : null;
    if (!p || !p.snapAt) return null;
    const m = markOf(i);
    const seg = segment(i);
    // Hand-placed plays start at the snap; auto-synced ones carry an estimated snap.
    const snapT = m && typeof m.snap === 'number' ? m.snap : seg ? seg.s : t;
    return p.snapAt + (t - snapT) * 1000 + state.audioOffset * 1000;
  }

  // Broadcast readiness, reported back by the broadcast tab.
  const audioLink = { ready: false, at: 0, readyAt: 0 };
  const audioConnected = () => performance.now() - audioLink.at < 2500;

  // Hold the All-22 video at the start of a play until the broadcast has loaded that spot.
  const hold = { index: null, since: 0, ours: false };
  let lastStartedIndex = null;
  const HOLD_TIMEOUT = 8000;
  function gateAudio(i) {
    const v = state.video;
    if (!state.prefs.broadcastAudio || !audioConnected() || i < 0) { hold.index = null; lastStartedIndex = i; return; }
    const now = performance.now();
    if (hold.index != null) {
      const ready = audioLink.ready && audioLink.readyAt > hold.since + 300;
      if (ready || now - hold.since > HOLD_TIMEOUT || i !== hold.index) {
        if (!ready && i === hold.index) toast('Broadcast audio is slow to load; playing without waiting');
        const resume = hold.ours;
        hold.index = null;
        lastStartedIndex = i;
        if (resume && v.paused) v.play().catch(() => {});
      }
      return;
    }
    if (!v.paused && i !== lastStartedIndex) {
      if (audioLink.ready && audioLink.readyAt > now - 400) { lastStartedIndex = i; return; } // already loaded
      hold.index = i; hold.since = now; hold.ours = true;
      v.pause();
      toast('Loading broadcast audio for this play…');
    }
  }

  function driveAudio(i, t) {
    if (state.isAudioTab || !state.prefs.broadcastAudio) return;
    gateAudio(i);
    const v = state.video;
    // The broadcast simply keeps running from this play's snap (through the end zone view,
    // commentary included) until the next play starts, then jumps there.
    const w = wallFor(i, t);
    const holding = hold.index != null;
    const playing = !!w && !holding && !v.paused && !v.seeking && v.readyState >= 2;
    // Send at least 4 times a second, and right away when play starts, stops or changes.
    const key = `${i}|${playing}`;
    const now = performance.now();
    if (key === lastDriveKey && now - lastDriveSent < 250) return;
    lastDriveKey = key;
    lastDriveSent = now;
    send({
      type: 'audioDrive',
      gameId: state.game.gameId,
      playIndex: i,
      w,
      playing,
      reason: !w ? 'no synced play here'
        : holding ? 'loading this play' : v.paused ? 'All-22 paused'
        : v.seeking || v.readyState < 2 ? 'All-22 buffering' : 'playing',
      rate: v.playbackRate,
      sentAt: Date.now(), // lets the broadcast tab allow for the time the message took
    });
  }

  // The full-game replay leaves out the commercial breaks, so the broadcast runs short of the
  // real clock by the length of every break. Breaks show up in the play-by-play as unusually
  // long gaps between snaps (about 3 minutes, against 30-60 s normally). Across a break we
  // assume the broadcast showed a normal gap's worth, which gets the audio within seconds
  // instead of minutes; an anchor (B) or nudge ([ ]) after the break makes it exact.
  const BREAK_GAP = 140000;
  const AFTER_BREAK = 45000;
  let breakCache = { plays: null, list: [] };
  function breakList() {
    if (breakCache.plays !== state.plays) {
      const snaps = state.plays.map((p) => p.snapAt).filter(Boolean).sort((a, b) => a - b);
      const list = [];
      for (let k = 1; k < snaps.length; k++) {
        const gap = snaps[k] - snaps[k - 1];
        if (gap > BREAK_GAP) list.push({ at: snaps[k], cut: gap - AFTER_BREAK });
      }
      breakCache = { plays: state.plays, list };
    }
    return breakCache.list;
  }
  // Milliseconds of break cut out between wall-clock moments x < y, and how many breaks.
  function cutBetween(x, y) {
    let cut = 0, n = 0;
    for (const br of breakList()) if (br.at > x + 1000 && br.at <= y + 1500) { cut += br.cut; n++; }
    return { cut, n };
  }
  let lastEstimated = false;
  function broadcastTimeFor(w) {
    lastEstimated = false;
    if (!state.anchors.length || w == null) return null;
    const sorted = [...state.anchors].sort((a, b) => a.w - b.w);
    let a = null;
    // A correction point belongs to its play, including the moments just before the snap.
    for (const x of sorted) if (x.w <= w + 1500) a = x;
    if (a) {
      const { cut, n } = cutBetween(a.w, w);
      lastEstimated = n > 0;
      return a.b + (w - a.w - cut) / 1000;
    }
    a = sorted[0];
    const { cut, n } = cutBetween(w, a.w);
    lastEstimated = n > 0;
    return a.b - (a.w - w - cut) / 1000;
  }

  let lastFollowSeek = 0;
  let lastReport = 0;
  function reportAudio(ready) {
    const now = performance.now();
    if (now - lastReport < 200) return;
    lastReport = now;
    send({ type: 'audioStatus', ready, estimated: lastEstimated });
  }
  let lastFollowTime = -1;
  let lastFollowMove = 0;
  let followStatus = 'waiting for the All-22 tab';
  let seekLead = 0.15; // seconds; adjusted after every seek
  let seekCheck = false;
  function followAudio(msg) {
    state.lastDrive = msg;
    renderAudioBadge();
    const v = state.video;
    if (!v || !state.game || msg.gameId !== state.game.gameId || !state.prefs.broadcastAudio) return;
    if (state.scanning) { followStatus = 'scanning the broadcast'; return; } // the scan drives the video
    // While you're looking at and using this tab, hands off, so you can scrub and anchor.
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    // Where the All-22 is *now*: the message is a few milliseconds old by the time it lands.
    const age = msg.playing && msg.sentAt ? Math.min(1000, Math.max(0, Date.now() - msg.sentAt)) : 0;
    const b = broadcastTimeFor(msg.w == null ? null : msg.w + age * (msg.rate || 1));
    if (b == null) { followStatus = state.anchors.length ? 'waiting for a synced play' : 'no anchor yet: press B at a snap'; if (!v.paused) v.pause(); return; }
    if (!msg.playing) {
      // Not playing: park the broadcast at the target spot so it buffers there in advance.
      lastFollowMove = performance.now(); // don't count a deliberate pause as a stall
      if (!v.paused) v.pause();
      const nowP = performance.now();
      if (!v.seeking && Math.abs(v.currentTime - b) > 0.5 && nowP - lastFollowSeek > 1000) {
        lastFollowSeek = nowP;
        v.currentTime = b;
      }
      const ready = !v.seeking && v.readyState >= 3 && Math.abs(v.currentTime - b) <= 0.6;
      followStatus = `${ready ? 'ready' : 'loading'} (${msg.reason || 'All-22 not playing'})`;
      reportAudio(ready);
      return;
    }
    // Stall watchdog: if the broadcast should be playing but its clock hasn't moved for 1.5 s
    // (common in a background tab, where Chrome slows the player's loading), kick it with a
    // fresh seek and play.
    const nowMs = performance.now();
    if (Math.abs(v.currentTime - lastFollowTime) > 0.05) { lastFollowTime = v.currentTime; lastFollowMove = nowMs; }
    const stalled = nowMs - lastFollowMove > 1500;
    followStatus = `${stalled ? 'stalled, retrying' : 'following'} · drift ${(v.currentTime - b).toFixed(1)} s` +
      (lastEstimated ? ' · timing estimated after a commercial break: press B at a snap to make it exact' : '') +
      (v.readyState < 3 ? ` · loading (state ${v.readyState})` : '') + (document.hidden ? ' · background tab' : '');
    if (stalled && nowMs - lastFollowSeek > 3000) {
      lastFollowSeek = nowMs;
      lastFollowMove = nowMs;
      v.playbackRate = msg.rate;
      v.currentTime = b + seekLead;
      seekCheck = true;
      v.play().catch(() => {});
      return;
    }
    v.muted = false;
    if (v.paused) v.play().catch(() => {});
    reportAudio(!v.seeking && v.readyState >= 3);
    // Streams can't land exactly where you seek and take a moment to buffer, so constant small
    // seeks would loop the same second of audio. Seek only for big jumps (a new play), at most
    // every 2 seconds, and never mid-seek; close the remaining gap by playing slightly faster or
    // slower (pitch is preserved).
    if (v.seeking) return;
    const now = performance.now();
    const drift = v.currentTime - b; // > 0: broadcast is ahead
    // Learn how far ahead to aim a seek: after each one, see where we actually landed once
    // playing again and correct the lead for next time (instead of a fixed guess).
    if (seekCheck && !v.paused && v.readyState >= 3 && Math.abs(drift) < 3) {
      seekCheck = false;
      seekLead = Math.min(1.5, Math.max(0, seekLead - drift * 0.6));
    }
    if (Math.abs(drift) > 3 && now - lastFollowSeek > 2000) {
      console.info('[Enhanced22] broadcast audio seek', v.currentTime, '->', b, 'lead', seekLead.toFixed(2));
      lastFollowSeek = now;
      v.playbackRate = msg.rate;
      v.currentTime = b + seekLead; // seeking takes a moment; aim that far ahead
      seekCheck = true;
      return;
    }
    // Close small gaps smoothly: the speed change is proportional to the gap (at most 8%), and
    // anything under 40 ms is left alone.
    const k = Math.abs(drift) < 0.04 ? 0 : Math.max(-0.08, Math.min(0.08, drift * 0.4));
    const want = msg.rate * (1 - k);
    if (Math.abs(v.playbackRate - want) > 0.005) v.playbackRate = want;
  }

  function addAnchor() {
    const d = state.lastDrive;
    const p = d && d.playIndex >= 0 ? state.plays[d.playIndex] : null;
    if (!p || !p.snapAt) return toast('Open the All-22 replay on a synced play first');
    state.anchors = state.anchors.filter((a) => Math.abs(a.w - p.snapAt) > 1000);
    state.anchors.push({ w: p.snapAt, b: state.video.currentTime });
    saveMarks();
    toast(`Audio anchored to ${E22.quarter(p.qtr)} ${E22.clock(p.time)} ${E22.typeLabel(p)}`);
  }

  function removeLastAnchor() {
    if (!state.anchors.pop()) return;
    saveMarks();
    toast('Removed last audio anchor');
  }

  function renderAudioBadge() {
    if (!root || !state.isAudioTab) return;
    const d = state.lastDrive;
    const p = d && d.playIndex >= 0 ? state.plays[d.playIndex] : null;
    el.audio.classList.remove('hidden');
    if (el.bscan && !state.scanning && !el.bscan.dataset.init) { el.bscan.dataset.init = '1'; renderBscanButton(); }
    el.atext.textContent =
      `Broadcast audio source · ${state.anchors.length} anchor${state.anchors.length === 1 ? '' : 's'}` +
      (p ? ` · Press B at the snap of ${E22.quarter(p.qtr)} ${E22.clock(p.time)} ${E22.typeLabel(p)}` +
        `${p.pos ? ` (${p.pos})` : ''}` : '') +
      ` · Status: ${followStatus}`;
  }

  let skipCooldownUntil = 0;
  let recentSkips = [];
  function autoSkip(seg, t) {
    const target = seg.next;
    const now = performance.now();
    recentSkips = recentSkips.filter((x) => now - x < 15000);
    recentSkips.push(now);
    if (recentSkips.length > 3) {
      // Something is off (bad sync marks, or the player fighting our seeks). Stop rather than loop.
      state.prefs.autoSkip = false;
      savePrefs();
      render();
      toast('Auto-skip turned off: it was skipping too often. Check the synced plays, then turn it back on with V.');
      recentSkips = [];
      return;
    }
    skipCooldownUntil = now + 2000;
    seek(target, 'auto-skip end zone view');
    toast(`Skipped at ${fmtTime(t)} (play synced at ${fmtTime(seg.s)}, next at ${fmtTime(seg.next)}) · V turns it off`);
  }

  function onSeeked() {
    if (state.internalSeek) { state.internalSeek = false; state.suppressSkipFor = null; return; }
    // The user scrubbed by hand. If they landed inside an end zone view, let it play.
    const t = state.video.currentTime;
    const i = currentIndex(t);
    const seg = i >= 0 ? segment(i) : null;
    state.suppressSkipFor = seg && seg.end != null && t >= seg.end ? i : null;
  }

  // ---------- UI ----------
  let host = null;
  let root = null;
  const el = {};

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .wrap { position: absolute; inset: 0; pointer-events: none; }
    .bug { position: absolute; top: 12px; left: 12px; background: rgba(10,14,22,.82); color: #fff;
      border-radius: 8px; padding: 8px 12px; min-width: 260px; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
    .bug .l1 { display: flex; gap: 10px; align-items: baseline; font-size: 18px; font-weight: 700; }
    .bug .clock { font-variant-numeric: tabular-nums; }
    .bug .dd { color: #ffd34d; }
    .bug .l2 { display: flex; gap: 10px; align-items: center; margin-top: 4px; font-size: 13px; color: #cfd6e4; }
    .badge { background: #2f6fed; color: #fff; border-radius: 4px; padding: 1px 6px; font-size: 12px; font-weight: 600; }
    .sync { position: absolute; left: 12px; bottom: 56px; background: rgba(10,14,22,.85); color: #fff;
      border-radius: 8px; padding: 8px 12px; font-size: 13px; max-width: 60%; border-left: 3px solid #ffd34d; }
    .sync b { color: #ffd34d; }
    .sync .keys { color: #9aa6bd; margin-top: 3px; font-size: 12px; }
    .audio { pointer-events: auto; }
    .audio { position: absolute; left: 12px; top: 12px; right: 12px; background: rgba(10,14,22,.85); color: #fff;
      border-radius: 8px; padding: 8px 12px; font-size: 13px; border-left: 3px solid #3ddc84; }
    .toast { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); background: rgba(0,0,0,.85);
      color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity .2s; }
    .toast.show { opacity: 1; }
    .audio:not(.hidden) ~ .toast { top: 60px; }
    .resize { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; z-index: 2;
      background: linear-gradient(135deg, transparent 50%, #9aa6bd 50%, #9aa6bd 58%, transparent 58%, transparent 70%, #9aa6bd 70%, #9aa6bd 78%, transparent 78%); }
    .panel { position: absolute; top: 12px; right: 12px; bottom: 56px; width: 290px; pointer-events: auto;
      background: rgba(10,14,22,.88); color: #fff; border-radius: 8px; display: flex; flex-direction: column;
      overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
    .panel header { padding: 8px 10px; font-size: 13px; font-weight: 600; border-bottom: 1px solid #2a3245;
      cursor: move; user-select: none; }
    .titlebar { display: flex; align-items: center; gap: 6px; }
    .titlebar .title { flex: 1; }
    .grip { color: #9aa6bd; }
    .change { font: inherit; font-size: 11px; color: #9ec0ff; background: none; border: 0; cursor: pointer; padding: 0; }
    .change:hover { text-decoration: underline; }
    .bug { pointer-events: auto; cursor: move; user-select: none; }
    .picker { padding: 10px; font-size: 12px; }
    .picker p { margin: 0 0 8px; color: #cfd6e4; line-height: 1.4; }
    .picker select { font: inherit; margin-left: 6px; }
    .picker .wk { color: #9aa6bd; font-weight: 600; margin: 10px 0 4px; }
    .picker .g { padding: 6px 8px; border-radius: 4px; cursor: pointer; display: flex; justify-content: space-between; }
    .picker .g:hover { background: #2f6fed; }
    .picker .g.guess { background: #1f3b78; }
    .picker .d { color: #9aa6bd; }
    .panel header .sub { font-weight: 400; color: #9aa6bd; font-size: 12px; margin-top: 2px; }
    .panel .toggles { display: flex; gap: 10px; margin-top: 6px; font-weight: 400; font-size: 12px; color: #cfd6e4; }
    .panel .toggles label { cursor: pointer; display: flex; gap: 4px; align-items: center; }
    .audiosrc { display: block; width: 100%; margin-top: 6px; font: inherit; font-size: 11px; font-weight: 600;
      color: #fff; background: #1c7c4a; border: 0; border-radius: 5px; padding: 4px; cursor: pointer; }
    .audiosrc:hover { background: #239b5c; }
    .audio button { margin-left: 10px; font: inherit; font-size: 11px; font-weight: 600; color: #fff;
      background: #2a3245; border: 1px solid #3a4560; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
    .autosync { display: block; width: 100%; margin-top: 8px; font: inherit; font-size: 12px; font-weight: 700;
      color: #fff; background: #2f6fed; border: 0; border-radius: 5px; padding: 6px; cursor: pointer; }
    .autosync:hover { background: #4a82ff; }
    .autosync.running { background: #b54708; }
    .controls { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .controls button { font: inherit; font-size: 11px; font-weight: 600; color: #fff; background: #2a3245;
      border: 1px solid #3a4560; border-radius: 4px; padding: 3px 6px; cursor: pointer; }
    .controls button:hover { background: #2f6fed; }
    .status { margin-top: 6px; font-size: 11px; font-weight: 400; color: #9aa6bd; }
    .list { overflow-y: auto; flex: 1; font-size: 12px; }
    .qh { position: sticky; top: 0; background: #1b2232; color: #9aa6bd; padding: 3px 10px; font-weight: 600; }
    .row { display: grid; grid-template-columns: 62px 38px 1fr; gap: 6px; padding: 5px 10px; cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,.04); }
    .row:hover { background: rgba(255,255,255,.07); }
    .row.cur { background: #2f6fed; }
    .row.unsynced { opacity: .45; cursor: default; }
    .row.skip { opacity: .3; text-decoration: line-through; cursor: default; }
    .row .t { font-variant-numeric: tabular-nums; color: #cfd6e4; }
    .row .pos { font-weight: 700; }
    .row .ty .sit { color: #9aa6bd; }
    .row .det { grid-column: 3; color: #cfd6e4; font-size: 12px; margin-top: -2px; }
    .row.cur .det { color: #fff; }
    .td { background: #e5484d; color: #fff; border-radius: 3px; padding: 0 5px; font-size: 11px; font-weight: 700; margin-left: 6px; }
    .row.tdrow { box-shadow: inset 3px 0 0 #e5484d; }
    .bug .l3 { margin-top: 4px; font-size: 13px; color: #fff; }
    .bug .l3:empty { display: none; }
    .empty { padding: 12px; color: #9aa6bd; font-size: 12px; line-height: 1.5; }
    .hidden { display: none !important; }
  `;

  function buildUi() {
    host = document.createElement('div');
    host.id = 'enhanced22-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="bug hidden"><div class="l1"><span class="clock"></span><span class="dd"></span><span class="yl"></span></div>
          <div class="l2"><span class="poss"></span><span class="score"></span><span class="badge"></span></div>
          <div class="l3"></div></div>
        <div class="sync hidden"></div>
        <div class="audio hidden"><span class="atext"></span><button class="bscan">Find plays in this broadcast</button><button class="bexport">Export broadcast scan</button><button class="astop">Stop using this tab for audio</button></div>
        <div class="toast"></div>
        <div class="panel">
          <header><div class="titlebar"><span class="grip" title="Drag to move">⠿</span><div class="title">Enhanced22</div>
              <button class="change" title="Choose a different game">Change game</button></div><div class="sub"></div>
            <button class="audiosrc" title="Use this tab as the broadcast audio source">Use this tab for broadcast audio</button>
            <div class="toggles">
              <label><input type="checkbox" data-pref="autoSkip"> Auto-skip end zone view</label>
              <label><input type="checkbox" data-pref="overlay"> Overlay</label>
              <label><input type="checkbox" data-pref="broadcastAudio"> Broadcast audio</label>
            </div>
            <button class="autosync" title="Fast-forwards through the replay once to find every play">Auto-sync game</button>
            <div class="controls">
              <button data-act="mark" title="Press at the snap of the sideline view">Sync play (S)</button>
              <button data-act="skip" title="This play isn't in the replay">Not in replay (X)</button>
              <button data-act="undo">Undo (Z)</button>
              <button data-act="prev">◀ Prev (P)</button>
              <button data-act="next">Next (N) ▶</button>
              <button data-act="reset" title="Clear every synced play for this game">Reset sync</button>
 <button data-act="export" title="Save the auto-sync scan to a file you can send to the developer">Export sync data</button>
              <button data-act="diag" title="Copy technical details about this player to send to the developer">Copy diagnostics</button>
            </div>
            <div class="status"></div></header>
          <div class="list"></div>
          <div class="resize" title="Drag to resize · double-click to reset"></div>
        </div>
      </div>`;
    for (const k of ['bug', 'sync', 'toast', 'panel', 'list', 'audio']) el[k] = root.querySelector(`.${k}`);
    el.clock = root.querySelector('.clock');
    el.dd = root.querySelector('.dd');
    el.yl = root.querySelector('.yl');
    el.poss = root.querySelector('.poss');
    el.score = root.querySelector('.score');
    el.badge = root.querySelector('.badge');
    el.l3 = root.querySelector('.bug .l3');
    el.title = root.querySelector('header .title');
    el.sub = root.querySelector('header .sub');
    el.status = root.querySelector('header .status');
    root.querySelector('header .change').addEventListener('click', () => { state.picking = true; renderList(); });
    makeDraggable(el.panel, root.querySelector('.panel header'), 'panelPos');
    watchPanelSize();
    makeDraggable(el.bug, el.bug, 'bugPos');
    el.controls = root.querySelector('header .controls');
    el.autosync = root.querySelector('header .autosync');
    el.atext = root.querySelector('.audio .atext');
    el.bscan = root.querySelector('.audio .bscan');
    el.bscan.addEventListener('click', () => {
      el.bscan.blur();
      if (state.scanning) { state.stopScan = true; return; }
      runBroadcastScan();
    });
    root.querySelector('.audio .bexport').addEventListener('click', (ev) => { ev.currentTarget.blur(); exportBroadcastScan(); });
    root.querySelector('.audio .astop').addEventListener('click', async () => {
      await send({ type: 'setAudioTabSelf', on: false });
      if (state.video && !state.video.paused) state.video.pause();
    });
    root.querySelector('header .audiosrc').addEventListener('click', async (ev) => {
      ev.currentTarget.blur();
      await send({ type: 'setAudioTabSelf', on: true });
      toast('This tab is now the broadcast audio source. Press B at a snap to line it up.');
    });
    el.autosync.addEventListener('click', () => {
      el.autosync.blur();
      if (state.scanning) { state.stopScan = true; return; }
      runAutoSync();
    });
    let resetArmed = 0;
    const ACTIONS = {
      mark: markNext, skip: skipNext, undo, prev: () => jump(-1), next: () => jump(1),
      reset: () => {
        if (Date.now() - resetArmed > 4000) { resetArmed = Date.now(); return toast('Click Reset sync again to clear every synced play for this game'); }
        resetArmed = 0;
        state.marks = {};
        state.history = [];
        saveMarks();
        try { chrome.storage.local.remove(scanKey()).then(renderAutoButton); } catch { /* orphaned */ }
        toast('Sync cleared for this game');
      },
    };
    el.controls.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b || !state.video) return;
      if (b.dataset.act === 'diag') { copyDiagnostics(); b.blur(); return; }
      if (b.dataset.act === 'export') { exportSyncData(); b.blur(); return; }
      if (state.scanning) return toast('Auto-sync is running. Click Stop first.');
      if (!state.game) return toast('Pick the game from the list below first');
      ACTIONS[b.dataset.act]();
      b.blur();
    });
    root.querySelectorAll('input[data-pref]').forEach((cb) => {
      cb.addEventListener('change', () => { state.prefs[cb.dataset.pref] = cb.checked; savePrefs(); render(); });
    });
    el.list.addEventListener('click', (ev) => {
      const row = ev.target.closest('.row');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (ev.shiftKey && state.video) { // re-sync this play's start to the current frame
        const p = state.plays[i];
        state.marks[p.id] = { s: state.video.currentTime };
        if (!state.history.includes(p.id)) state.history.push(p.id);
        saveMarks();
        realignFromScan().then((ok) => toast(ok
          ? 'Moved this play here and re-matched the plays around it'
          : 'Moved this play\'s start to the current time'));
        return;
      }
      if (!hasStart(i)) {
        return toast(markOf(i)?.skip
          ? 'You marked this play as not in the replay'
          : 'Not synced yet, so its spot in the video is unknown. Sync up to it first (S at each snap).');
      }
      seek(markOf(i).s, 'clicked play in list');
      state.video.play?.();
    });
    // Keep keyboard focus on the page, not the checkboxes.
    root.addEventListener('mouseup', () => { if (root.activeElement?.blur) root.activeElement.blur(); });
  }

  function placeHost() {
    const v = state.video;
    if (!v || !host) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs !== v && fs.contains(v) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    const r = v.getBoundingClientRect();
    Object.assign(host.style, {
      top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`,
    });
  }

  let toastTimer = null;
  function toast(msg, ms = 1800) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  let lastBugIndex = null;
  function renderBug(i) {
    if (!root) return;
    const show = state.prefs.overlay && state.game && i >= 0;
    el.bug.classList.toggle('hidden', !show);
    if (show && i !== lastBugIndex) {
      const p = state.plays[i];
      el.clock.textContent = `${E22.quarter(p.qtr)} ${E22.clock(p.time)}`;
      el.dd.textContent = E22.downDistance(p);
      el.yl.textContent = p.type === 'kickoff' ? '' : E22.yardLine(p);
      el.poss.textContent = p.pos ? (p.type === 'kickoff' ? `${p.pos} receives` : `${p.pos} ball`) : '';
      el.score.textContent = E22.score(p, state.game);
      el.badge.textContent = E22.typeLabel(p);
      el.l3.textContent = E22.details(p);
      if (p.td) {
        const td = document.createElement('span');
        td.className = 'td';
        td.textContent = p.tdTeam ? `TD ${p.tdTeam}` : 'TD';
        el.l3.appendChild(td);
      }
      highlightRow(i);
    }
    if (i !== lastBugIndex) { lastBugIndex = i; if (!show) highlightRow(i); }
  }

  function renderSyncPrompt() {
    const i = state.game ? nextUnsyncedIndex() : -1;
    el.sync.classList.toggle('hidden', !(state.prefs.overlay && i >= 0));
    if (i < 0) return;
    const p = state.plays[i];
    const who = p.pos ? ` · ${p.pos}${p.type === 'kickoff' ? ' receives' : ' ball'}` : '';
    el.sync.innerHTML = '';
    const line = document.createElement('div');
    line.innerHTML = 'Next to sync: <b></b>';
    line.querySelector('b').textContent =
      `${E22.quarter(p.qtr)} ${E22.clock(p.time)} ${E22.typeLabel(p)}${who} ${E22.downDistance(p)}`;
    const keys = document.createElement('div');
    keys.className = 'keys';
    keys.textContent = 'S at the snap of the sideline view · X if this play isn\'t in the replay · Z undo';
    el.sync.append(line, keys);
  }

  function renderList() {
    if (!root) return;
    el.list.innerHTML = '';
    lastBugIndex = null;
    if (!state.game || state.picking) {
      el.title.textContent = 'Enhanced22';
      el.sub.textContent = '';
      renderPicker();
      return;
    }
    el.title.textContent = `${state.game.away} at ${state.game.home} · Week ${state.game.week}`;
    el.sub.textContent = `${syncedCount()} of ${state.plays.length} plays synced`;
    let q = null;
    const frag = document.createDocumentFragment();
    state.plays.forEach((p, i) => {
      if (p.qtr !== q) {
        q = p.qtr;
        const h = document.createElement('div');
        h.className = 'qh';
        h.textContent = q >= 5 ? 'Overtime' : `Quarter ${q}`;
        frag.appendChild(h);
      }
      const m = state.marks[p.id];
      const row = document.createElement('div');
      row.className = `row${m?.skip ? ' skip' : typeof m?.s === 'number' ? '' : ' unsynced'}`;
      row.dataset.i = i;
      row.title = m?.skip ? 'Not in the replay' : typeof m?.s === 'number' ? 'Click to jump to this play' : 'Not synced yet: press S at its snap to make it clickable';
      const t = document.createElement('span'); t.className = 't'; t.textContent = `${E22.quarter(p.qtr)} ${E22.clock(p.time)}`;
      const pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = p.pos || '';
      const ty = document.createElement('span'); ty.className = 'ty';
      ty.textContent = E22.typeLabel(p);
      const sit = document.createElement('span'); sit.className = 'sit';
      const dd = E22.downDistance(p);
      sit.textContent = dd && dd !== E22.typeLabel(p) ? ` · ${dd}` : '';
      ty.appendChild(sit);
      if (p.td) {
        const td = document.createElement('span');
        td.className = 'td';
        td.textContent = p.tdTeam && p.tdTeam !== p.pos ? `TD ${p.tdTeam}` : 'TD';
        ty.appendChild(td);
        row.classList.add('tdrow');
      }
      row.append(t, pos, ty);
      const det = E22.details(p);
      if (det) { const d = document.createElement('span'); d.className = 'det'; d.textContent = det; row.appendChild(d); }
      frag.appendChild(row);
    });
    el.list.appendChild(frag);
  }

  // ---------- game picker (inside the panel) ----------
  const NICK = {
    ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills', CAR: 'panthers', CHI: 'bears',
    CIN: 'bengals', CLE: 'browns', DAL: 'cowboys', DEN: 'broncos', DET: 'lions', GB: 'packers',
    HOU: 'texans', IND: 'colts', JAX: 'jaguars', KC: 'chiefs', LV: 'raiders', LAC: 'chargers',
    LA: 'rams', MIA: 'dolphins', MIN: 'vikings', NE: 'patriots', NO: 'saints', NYG: 'giants',
    NYJ: 'jets', PHI: 'eagles', PIT: 'steelers', SF: '49ers', SEA: 'seahawks', TB: 'buccaneers',
    TEN: 'titans', WAS: 'commanders',
  };
  function pageText() {
    let t = `${location.href} ${document.title}`;
    try { t += ` ${window.top.location.href} ${window.top.document.title}`; } catch { /* cross-origin */ }
    return t.toLowerCase();
  }
  const defaultSeason = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; };
  let pickerSeason = null;

  async function renderPicker() {
    const box = document.createElement('div');
    box.className = 'picker';
    const intro = document.createElement('p');
    intro.textContent = 'Which game is this replay? Pick it once and its plays load into this list.';
    const sel = document.createElement('select');
    const lab = document.createElement('label');
    lab.textContent = 'Season';
    for (let y = defaultSeason(); y >= 2016; y--) {
      const o = document.createElement('option'); o.value = o.textContent = y; sel.appendChild(o);
    }
    pickerSeason = pickerSeason || (state.game ? Number(state.game.gameId.slice(0, 4)) : defaultSeason());
    sel.value = pickerSeason;
    sel.addEventListener('change', () => { pickerSeason = Number(sel.value); renderList(); });
    lab.appendChild(sel);
    const status = document.createElement('p');
    status.textContent = 'Loading games… (the first time takes a few seconds)';
    box.append(intro, lab, status);
    if (state.game) {
      const back = document.createElement('button');
      back.className = 'change';
      back.textContent = `Keep ${state.game.away} at ${state.game.home}`;
      back.addEventListener('click', () => { state.picking = false; renderList(); render(); });
      box.insertBefore(back, lab);
    }
    el.list.innerHTML = '';
    el.list.appendChild(box);

    const season = pickerSeason;
    let r;
    r = await send({ type: 'getGames', season });
    if (season !== pickerSeason || !box.isConnected) return;
    if (!r?.ok) { status.textContent = `Couldn't load games: ${r?.error || 'unknown error'}`; return; }
    status.remove();
    const text = pageText();
    const isGuess = (g) => NICK[g.home] && NICK[g.away] && text.includes(NICK[g.home]) && text.includes(NICK[g.away]);
    const row = (g, guess) => {
      const d = document.createElement('div');
      d.className = `g${guess ? ' guess' : ''}`;
      const n = document.createElement('span'); n.textContent = `${g.away} at ${g.home}`;
      const dt = document.createElement('span'); dt.className = 'd'; dt.textContent = guess ? 'This replay?' : g.date;
      d.append(n, dt);
      d.addEventListener('click', () => {
        state.picking = false;
        storeSet({ activeGame: g });
      });
      return d;
    };
    const guesses = r.games.filter(isGuess);
    if (guesses.length) {
      const h = document.createElement('div'); h.className = 'wk'; h.textContent = 'Looks like';
      box.appendChild(h);
      guesses.slice(-3).reverse().forEach((g) => box.appendChild(row(g, true)));
    }
    let wk = null;
    for (const g of [...r.games].reverse()) {
      if (g.week !== wk) {
        wk = g.week;
        const h = document.createElement('div'); h.className = 'wk';
        h.textContent = g.seasonType === 'POST' ? `Playoffs · Week ${wk}` : `Week ${wk}`;
        box.appendChild(h);
      }
      box.appendChild(row(g, false));
    }
  }

  // ---------- dragging ----------
  // Positions are saved as fractions of the video size so they survive resizing and fullscreen.
  function makeDraggable(node, handle, prefKey) {
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button, input, select, label, .list')) return;
      ev.preventDefault();
      const wrap = root.querySelector('.wrap').getBoundingClientRect();
      const start = node.getBoundingClientRect();
      const dx = ev.clientX - start.left;
      const dy = ev.clientY - start.top;
      handle.setPointerCapture(ev.pointerId);
      const move = (e) => {
        // Anywhere in the browser window, as long as a bit of it stays on screen to grab.
        const vx = Math.min(Math.max(e.clientX - dx, 40 - start.width), window.innerWidth - 40);
        const vy = Math.min(Math.max(e.clientY - dy, 0), window.innerHeight - 30);
        const x = vx - wrap.left, y = vy - wrap.top;
        state.prefs[prefKey] = { x: x / wrap.width, y: y / wrap.height };
        applyPositions();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        savePrefs();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => { delete state.prefs[prefKey]; savePrefs(); applyPositions(); });
  }

  function applyPositions() {
    if (!root) return;
    for (const [node, key] of [[el.panel, 'panelPos'], [el.bug, 'bugPos']]) {
      const p = state.prefs[key];
      if (p) {
        Object.assign(node.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, right: 'auto' });
        if (node === el.panel) node.style.bottom = 'auto';
      } else {
        node.style.left = node.style.top = node.style.right = node.style.bottom = '';
      }
    }
    const size = state.prefs.panelSize;
    el.panel.style.width = size ? `${size.w}px` : '';
    el.panel.style.height = size ? `${size.h}px` : state.prefs.panelPos ? '75%' : '';
  }

  // Resize the panel by dragging its bottom-right grip (double-click the grip to reset).
  function watchPanelSize() {
    const grip = root.querySelector('.resize');
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      grip.setPointerCapture(ev.pointerId);
      const r = el.panel.getBoundingClientRect();
      const wrap = root.querySelector('.wrap').getBoundingClientRect();
      if (!state.prefs.panelPos) { // pin the top-left corner so the grip follows the mouse
        state.prefs.panelPos = { x: (r.left - wrap.left) / wrap.width, y: (r.top - wrap.top) / wrap.height };
      }
      const move = (e) => {
        const w = Math.min(Math.max(160, r.width + e.clientX - ev.clientX), window.innerWidth);
        const h = Math.min(Math.max(120, r.height + e.clientY - ev.clientY), window.innerHeight);
        state.prefs.panelSize = { w: Math.round(w), h: Math.round(h) };
        applyPositions();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        savePrefs();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    grip.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      delete state.prefs.panelSize;
      savePrefs();
      applyPositions();
    });
  }

  let highlighted = null;
  function highlightRow(i) {
    if (highlighted) highlighted.classList.remove('cur');
    highlighted = i >= 0 ? el.list.querySelector(`.row[data-i="${i}"]`) : null;
    if (highlighted) {
      highlighted.classList.add('cur');
      const lr = el.list.getBoundingClientRect();
      const rr = highlighted.getBoundingClientRect();
      if (rr.top < lr.top + 20 || rr.bottom > lr.bottom - 20) {
        el.list.scrollTop += rr.top - lr.top - lr.height / 3;
      }
    }
  }

  let lastStatus = '';
  function renderStatus(t, v) {
    const fmt = (x) => {
      if (!Number.isFinite(x)) return '--:--';
      const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = Math.floor(x % 60);
      return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
    };
    let txt = `Video ${fmt(t)} / ${fmt(v.duration)} · ${v.paused ? 'paused' : 'playing'}`;
    const i = state.game ? currentIndex(t) : -1;
    const seg = i >= 0 ? segment(i) : null;
    if (seg) {
      txt += ` · this play from ${fmt(seg.s)}` +
        (seg.end != null ? `, end zone view ≈ ${fmt(seg.end)}, next play ${fmt(seg.next)}` : '');
    }
    if (txt !== lastStatus) { lastStatus = txt; el.status.textContent = txt; }
  }

  function fmtTime(x) {
    if (!Number.isFinite(x)) return '--:--';
    const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = Math.floor(x % 60);
    return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function render() {
    if (!root) return;
    applyPositions();
    if (state.isAudioTab) {
      el.panel.classList.add('hidden');
      el.bug.classList.add('hidden');
      el.sync.classList.add('hidden');
      renderAudioBadge();
      return;
    }
    el.audio.classList.add('hidden');
    root.querySelectorAll('input[data-pref]').forEach((cb) => { cb.checked = !!state.prefs[cb.dataset.pref]; });
    el.panel.classList.toggle('hidden', !state.prefs.list);
    if (state.game) el.sub.textContent = `${syncedCount()} of ${state.plays.length} plays synced`;
    renderSyncPrompt();
    lastBugIndex = null;
    if (state.video) renderBug(currentIndex(state.video.currentTime));
  }

  // ---------- keyboard ----------
  const KEYS = {
    KeyS: markNext, KeyX: skipNext, KeyZ: undo, KeyE: markSidelineEnd,
    KeyN: () => jump(1), KeyP: () => jump(-1),
    KeyO: () => { state.prefs.overlay = !state.prefs.overlay; savePrefs(); render(); },
    KeyL: () => { state.prefs.list = !state.prefs.list; savePrefs(); render(); },
    KeyV: () => {
      state.prefs.autoSkip = !state.prefs.autoSkip; savePrefs(); render();
      toast(state.prefs.autoSkip ? 'Auto-skip end zone view: on' : 'Auto-skip end zone view: off');
    },
  };
  const AUDIO_KEYS = { KeyB: addAnchor, KeyU: removeLastAnchor };
  // [ and ] (either tab) move the broadcast audio later or earlier from the current play on.
  // The full-game replay leaves out commercial breaks, so the right offset can change after
  // each break; nudging adds a correction point at this play and leaves earlier plays alone.
  function nudgeAudio(delta) {
    const i = state.isAudioTab ? state.lastDrive?.playIndex ?? -1 : currentIndex(state.video.currentTime);
    const p = i >= 0 ? state.plays[i] : null;
    const b = p && p.snapAt ? broadcastTimeFor(p.snapAt) : null;
    if (b == null) {
      state.audioOffset = Math.round((state.audioOffset + delta) * 100) / 100;
      saveMarks();
      toast(`Broadcast audio offset: ${state.audioOffset > 0 ? '+' : ''}${state.audioOffset.toFixed(2)} s`);
      return;
    }
    const here = state.anchors.find((a) => Math.abs(a.w - p.snapAt) <= 1000);
    if (here) here.b = Math.round((here.b + delta) * 1000) / 1000;
    else state.anchors.push({ w: p.snapAt, b: Math.round((b + delta) * 1000) / 1000 });
    saveMarks();
    toast(`Audio ${Math.abs(delta).toFixed(1)} s ${delta < 0 ? 'later' : 'earlier'} from ${E22.quarter(p.qtr)} ${E22.clock(p.time)} on`);
  }
  KEYS.BracketLeft = AUDIO_KEYS.BracketLeft = () => nudgeAudio(-0.1);
  KEYS.BracketRight = AUDIO_KEYS.BracketRight = () => nudgeAudio(0.1);
  function handleKey(code) {
    if (!state.video || !state.game) return false;
    const fn = (state.isAudioTab ? AUDIO_KEYS : KEYS)[code];
    if (!fn) return false;
    fn();
    return true;
  }
  function onKeyDown(ev) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey || ev.repeat) return;
    const tgt = ev.composedPath()[0];
    if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName || ''))) return;
    if (!KEYS[ev.code] && !AUDIO_KEYS[ev.code]) return;
    if (state.video && state.game) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      handleKey(ev.code);
    } else if (!state.video) {
      // The video lives in another frame of this page (or the player has focus there); pass it on.
      send({ type: 'relayKey', code: ev.code });
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // ---------- find the replay video ----------
  // Players often keep several <video> elements (ads, previews, the real stream).
  // Prefer the big one that is actually playing a long video.
  function findVideo() {
    let best = null;
    let bestScore = 0;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 320 || r.height < 180) return;
      let score = r.width * r.height;
      if (v.readyState > 0) score *= 2;
      if (!v.paused) score *= 2;
      if (Number.isFinite(v.duration) && v.duration > 600) score *= 4;
      if (score > bestScore) { best = v; bestScore = score; }
    });
    return best;
  }

  // ---------- automatic sync ----------
  // Scan progress is saved per game, so a stopped scan keeps what it found and resumes later.
  const scanKey = () => `scan:${state.game.gameId}`;
  const roundFrame = (f) => ({
    t: Math.round(f.t * 100) / 100, diff: Math.round(f.diff * 1e4) / 1e4,
    horiz: Math.round(f.horiz * 1e3) / 1e3, luma: Math.round(f.luma * 1e3) / 1e3,
  });

  async function renderAutoButton() {
    if (!el.autosync || state.scanning) return;
    let label = 'Auto-sync game';
    if (state.game) {
      const saved = (await storeGet(scanKey()))[scanKey()];
      if (saved && !saved.complete && saved.duration) {
        label = `Resume auto-sync (${Math.round((saved.upTo / saved.duration) * 100)}% done)`;
      } else if (saved?.complete) {
        label = 'Auto-sync again';
      }
    }
    el.autosync.textContent = label;
  }

  // After you fix a play by hand, redo the matching from the saved scan with your fixes pinned,
  // so one correction also repairs the plays after it. No rescan needed.
  async function realignFromScan() {
    if (!state.game) return false;
    const saved = (await storeGet(scanKey()))[scanKey()];
    if (!saved?.frames?.length) return false;
    const fixed = {};
    state.plays.forEach((p, j) => {
      const m = state.marks[p.id];
      if (m && !m.auto && typeof m.s === 'number') fixed[j] = m.s;
    });
    const { marks, summary, detail } = E22Auto.build(saved.frames, state.plays, { partial: !saved.complete, fixed });
    const manual = Object.fromEntries(Object.entries(state.marks).filter(([, m]) => !m.auto));
    state.marks = { ...marks, ...manual };
    state.lastAutoSummary = { ...summary, complete: saved.complete, upTo: saved.upTo };
    state.lastAutoDetail = detail;
    saveMarks();
    return true;
  }

  async function exportSyncData() {
    if (!state.game) return toast('Pick the game first');
    const saved = (await storeGet(scanKey()))[scanKey()];
    const hasScan = !!saved?.frames?.length;
    const hand = Object.values(state.marks).filter((m) => !m.auto && typeof m.s === 'number').length;
    if (!hasScan && !hand) return toast('Nothing to export yet: run Auto-sync or sync a few plays by hand first.');
    const fixed = {};
    state.plays.forEach((p, j) => { const m = state.marks[p.id]; if (m && !m.auto && typeof m.s === 'number') fixed[j] = m.s; });
    const { summary, detail } = hasScan
      ? E22Auto.build(saved.frames, state.plays, { partial: !saved.complete, fixed })
      : { summary: null, detail: { shots: [], matches: [] } };
    const data = {
      version: chrome.runtime.getManifest().version,
      game: state.game.gameId,
      duration: hasScan ? saved.duration : state.video?.duration,
      complete: hasScan ? saved.complete : null,
      summary,
      shots: detail.shots,
      matches: detail.matches,
      handPlaced: Object.entries(state.marks).filter(([, m]) => !m.auto).map(([id, m]) => ({ id, ...m })),
      frames: hasScan ? saved.frames.map((f) => [f.t, f.diff, f.horiz, f.luma]) : [],
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `enhanced22-sync-${state.game.gameId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Saved the sync data file to your Downloads folder');
  }

  async function runAutoSync() {
    const v = state.video;
    if (!v || !state.game) return toast('Pick the game first');
    if (!Number.isFinite(v.duration) || v.duration < 60) return toast('Start the All-22 replay first, then try again.');
    const key = scanKey();
    let saved = (await storeGet(key))[key];
    if (saved && (saved.complete || Math.abs(saved.duration - v.duration) > 5)) saved = null; // fresh run
    const old = saved ? saved.frames : [];
    const startAt = saved ? Math.max(0, saved.upTo - 3) : 0;
    state.scanning = true;
    state.stopScan = false;
    el.autosync.classList.add('running');
    el.autosync.textContent = 'Auto-sync: starting… (click to stop)';
    const started = performance.now();
    const startFrac = startAt / v.duration;
    try {
      const fresh = await E22Auto.scan(v, {
        startAt,
        shouldStop: () => state.stopScan || dead,
        onProgress: (f) => {
          const pct = Math.round(f * 100);
          const done = f - startFrac;
          const secs = (performance.now() - started) / 1000;
          const eta = done > 0.02 ? Math.round(((1 - f) * secs / done) / 60) : null;
          el.autosync.textContent = `Auto-sync: scanning ${pct}%${eta != null ? ` · about ${eta} min left` : ''} (click to stop)`;
        },
      });
      if (dead) return;
      const lastOld = old.length ? old[old.length - 1].t : -1;
      const frames = old.concat(fresh.filter((f) => f.t > lastOld).map(roundFrame));
      const upTo = frames.length ? frames[frames.length - 1].t : 0;
      const complete = !state.stopScan && upTo >= v.duration - 2;
      await storeSet({ [key]: { frames, upTo, duration: v.duration, complete } });

      const fixed = {};
      state.plays.forEach((p, j) => { const m = state.marks[p.id]; if (m && !m.auto && typeof m.s === 'number') fixed[j] = m.s; });
      const { marks, summary } = E22Auto.build(frames, state.plays, { partial: !complete, fixed });
      console.info('[Enhanced22] auto-sync', summary);
      // Plays you placed by hand (S or shift-click) win over automatic ones.
      const manual = Object.fromEntries(Object.entries(state.marks).filter(([, m]) => !m.auto));
      state.marks = { ...marks, ...manual };
      state.history = Object.keys(manual);
      state.lastAutoSummary = { ...summary, complete, upTo };
      saveMarks();
      if (summary.coverage < 0.9) {
        toast(`The scan missed ${Math.round((1 - summary.coverage) * 100)}% of the video, so some plays may be off. ` +
          'Run Auto-sync again with this tab in front and nothing else busy.', 9000);
      } else toast(complete
        ? `Auto-sync placed ${summary.matched} of ${summary.plays} plays. Shift-click a play in the list to fix one.`
        : `Auto-sync paused. Kept ${summary.matched} plays found so far. Click Resume to continue.`);
    } catch (e) {
      toast(`Auto-sync failed: ${e.message}`);
    } finally {
      state.scanning = false;
      el.autosync.classList.remove('running');
      renderAutoButton();
    }
  }

  // ---------- broadcast scan ----------
  // Finds each play's snap in the broadcast video itself and lines the audio up per stretch
  // between commercial breaks (see bcastsync.js). Runs in the broadcast tab; resumable.
  const bscanKey = () => `bscan:${state.game.gameId}`;
  const roundB = (f) => ({ ...roundFrame(f), green: Math.round((f.green || 0) * 1e3) / 1e3 });

  async function renderBscanButton() {
    if (!el.bscan || state.scanning || !state.game) return;
    const saved = (await storeGet(bscanKey()))[bscanKey()];
    el.bscan.textContent = saved && !saved.complete && saved.duration
      ? `Resume finding plays (${Math.round((saved.upTo / saved.duration) * 100)}% done)`
      : saved?.complete ? 'Find plays again' : 'Find plays in this broadcast';
  }

  function applyBroadcastScan(saved) {
    const { anchors, summary, detail } = E22Bcast.build(saved.frames, state.plays, { duration: saved.duration });
    // Your own anchors and nudges stay; earlier automatic ones are replaced.
    state.anchors = state.anchors.filter((a) => !a.auto).concat(anchors);
    state.lastBscan = { summary, detail };
    saveMarks();
    return summary;
  }

  async function runBroadcastScan() {
    const v = state.video;
    if (!v || !state.game) return toast('Open the broadcast replay and pick the game first');
    if (!Number.isFinite(v.duration) || v.duration < 60) return toast('Start the broadcast replay first, then try again.');
    const key = bscanKey();
    let saved = (await storeGet(key))[key];
    if (saved && (saved.complete || Math.abs(saved.duration - v.duration) > 5)) saved = null;
    const old = saved ? saved.frames : [];
    const startAt = saved ? Math.max(0, saved.upTo - 3) : 0;
    state.scanning = true;
    state.stopScan = false;
    el.bscan.textContent = 'Finding plays: starting… (click to stop)';
    const started = performance.now();
    const startFrac = startAt / v.duration;
    try {
      const fresh = await E22Auto.scan(v, {
        startAt,
        shouldStop: () => state.stopScan || dead,
        onProgress: (f) => {
          const done = f - startFrac;
          const secs = (performance.now() - started) / 1000;
          const eta = done > 0.02 ? Math.round(((1 - f) * secs / done) / 60) : null;
          el.bscan.textContent = `Finding plays: ${Math.round(f * 100)}%${eta != null ? ` · about ${eta} min left` : ''} (click to stop)`;
        },
      });
      if (dead) return;
      const lastOld = old.length ? old[old.length - 1].t : -1;
      const frames = old.concat(fresh.filter((f) => f.t > lastOld).map(roundB));
      const upTo = frames.length ? frames[frames.length - 1].t : 0;
      const complete = !state.stopScan && upTo >= v.duration - 2;
      const data = { frames, upTo, duration: v.duration, complete };
      await storeSet({ [key]: data });
      const sum = applyBroadcastScan(data);
      toast(sum.placed
        ? `Found ${sum.playsMatched} snaps in the broadcast and lined up ${sum.placed} of ${sum.segments} stretches between commercial breaks` +
          (complete ? '.' : ' so far. Click Resume to scan the rest.')
        : 'Could not line up the broadcast automatically here. Press B at a snap instead, and please send the broadcast scan file.', 9000);
    } catch (e) {
      toast(`Broadcast scan failed: ${e.message}`);
    } finally {
      state.scanning = false;
      renderBscanButton();
    }
  }

  async function exportBroadcastScan() {
    if (!state.game) return toast('Pick the game first');
    const saved = (await storeGet(bscanKey()))[bscanKey()];
    if (!saved?.frames?.length) return toast('Run "Find plays in this broadcast" first (even a few minutes of it).');
    const r = E22Bcast.build(saved.frames, state.plays, { duration: saved.duration });
    const data = {
      version: chrome.runtime.getManifest().version,
      game: state.game.gameId,
      kind: 'broadcast',
      duration: saved.duration,
      complete: saved.complete,
      summary: r.summary,
      segments: r.detail,
      anchors: state.anchors,
      frames: saved.frames.map((f) => [f.t, f.diff, f.horiz, f.luma, f.green]),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `enhanced22-broadcast-${state.game.gameId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Saved the broadcast scan file to your Downloads folder');
  }

  // ---------- diagnostics ----------
  // Collects what the player exposes besides pixels (sources, clip changes, text tracks, the
  // streaming manifest's markers) so we can tell which signal could find plays automatically.
  // Query strings are stripped so no sign-in tokens end up in the report.
  const mediaEvents = [];
  function logMediaEvent(v, type) {
    mediaEvents.push({
      at: new Date().toISOString().slice(11, 19), type,
      src: stripUrl(v.currentSrc), duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
      t: +v.currentTime.toFixed(2),
    });
    if (mediaEvents.length > 40) mediaEvents.shift();
  }
  function stripUrl(u) {
    if (!u) return '';
    if (u.startsWith('blob:')) return 'blob:(media source)';
    try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return String(u).split('?')[0]; }
  }
  function summarizeManifest(text) {
    const count = (re) => (text.match(re) || []).length;
    const sample = (re) => (text.match(re) || []).slice(0, 6).map((l) => l.replace(/https?:\/\/[^\s"',]+/g, '(url)'));
    return {
      bytes: text.length,
      kind: text.startsWith('#EXTM3U') ? 'HLS' : /<MPD/i.test(text) ? 'DASH' : 'other',
      variants: count(/#EXT-X-STREAM-INF/g),
      segments: count(/#EXTINF/g),
      discontinuities: count(/#EXT-X-DISCONTINUITY\b/g),
      dateranges: count(/#EXT-X-DATERANGE/g),
      programDateTimes: count(/#EXT-X-PROGRAM-DATE-TIME/g),
      cues: count(/#EXT-X-CUE|#EXT-OATCLS|#EXT-X-SCTE/g),
      periods: count(/<Period\b/g),
      eventStreams: count(/<EventStream\b/g),
      samples: [
        ...sample(/#EXT-X-DATERANGE[^\n]*/g), ...sample(/#EXT-X-CUE[^\n]*/g),
        ...sample(/<Period\b[^>]*>/g), ...sample(/<Event\b[^>]*>/g),
        ...sample(/#EXT-X-PROGRAM-DATE-TIME[^\n]*/g).slice(0, 2),
      ],
    };
  }
  async function fetchText(u) {
    try { const r = await fetch(u, { credentials: 'include' }); return r.ok ? await r.text() : `HTTP ${r.status}`; }
    catch (e) { return `fetch failed: ${e.message}`; }
  }
  async function copyDiagnostics() {
    toast('Collecting diagnostics…');
    const vids = [...document.querySelectorAll('video')].map((v) => ({
      src: stripUrl(v.currentSrc || v.src),
      duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
      currentTime: +v.currentTime.toFixed(2),
      size: `${v.clientWidth}x${v.clientHeight}`,
      paused: v.paused,
      chosen: v === state.video,
      encrypted: !!v.mediaKeys,
      textTracks: [...v.textTracks].map((tt) => ({ kind: tt.kind, label: tt.label, mode: tt.mode, cues: tt.cues ? tt.cues.length : null })),
    }));
    const resources = [...new Set(performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => /m3u8|\.mpd|manifest|\/api\/|graphql|\.json|play|replay|game|video|vod/i.test(n))
      .filter((n) => !/\.(ts|m4s|mp4|aac|m4a|m4v|jpg|png|webp|gif|svg|woff2?|css|js)(\?|$)/i.test(n)))]
      .slice(-80);
    const manifests = [];
    for (const u of performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.m3u8|\.mpd/i.test(n)).slice(-4)) {
      const text = await fetchText(u);
      manifests.push({ url: stripUrl(u), ...(text.startsWith('#') || text.startsWith('<') ? summarizeManifest(text) : { error: text.slice(0, 120) }) });
    }
    const report = {
      version: chrome.runtime.getManifest().version,
      page: stripUrl(location.href),
      inFrame: window !== window.top,
      game: state.game?.gameId || null,
      synced: state.game ? syncedCount() : 0,
      autoSync: state.lastAutoSummary || null,
      audio: { isAudioTab: state.isAudioTab, anchors: state.anchors.length, offset: state.audioOffset, status: followStatus, lastDrive: state.lastDrive },
      videos: vids,
      mediaEvents,
      manifests,
      resources: resources.map(stripUrl),
    };
    const text = JSON.stringify(report, null, 1);
    try { await navigator.clipboard.writeText(text); toast('Diagnostics copied. Paste them into the chat.'); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'width:100%;height:160px;font-size:10px';
      el.list.prepend(ta);
      ta.select();
      toast('Copy the text at the top of the panel (Ctrl+C) and paste it into the chat.');
    }
  }

  function attach(v) {
    if (state.video === v) return;
    if (state.video) state.video.removeEventListener('seeked', onSeeked);
    state.video = v;
    v.addEventListener('seeked', onSeeked);
    for (const type of ['loadedmetadata', 'emptied', 'durationchange', 'ended']) {
      v.addEventListener(type, () => logMediaEvent(v, type));
    }
    logMediaEvent(v, 'attached');
    if (!host) { buildUi(); loadActiveGame().then(checkRole); }
    placeHost();
  }

  async function checkRole() {
    try {
      const r = await send({ type: 'whoami' });
      const was = state.isAudioTab;
      state.isAudioTab = !!r?.isAudioTab;
      if (was !== state.isAudioTab) render();
    } catch { /* extension reloaded */ }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'audioDrive' && state.isAudioTab) followAudio(msg);
    if (msg?.type === 'audioStatus' && !state.isAudioTab) {
      audioLink.at = performance.now();
      audioLink.ready = !!msg.ready;
      if (msg.estimated && state.video) {
        const i = currentIndex(state.video.currentTime);
        const seg = breakList().filter((br) => br.at <= (state.plays[i]?.snapAt ?? 0) + 1500).length;
        if (seg !== audioLink.warnedSeg) {
          audioLink.warnedSeg = seg;
          toast('Commercial break skipped here, so the audio timing is estimated. ' +
            'On the broadcast tab, press B at this play\'s snap (or use [ and ] here) to make it exact.', 8000);
        }
      }
      if (msg.ready) audioLink.readyAt = audioLink.at;
    }
    if (msg?.type === 'roleChanged') checkRole();
    if (msg?.type === 'key' && state.video) handleKey(msg.code);
  });

  // ---------- pick the game from the page address ----------
  // NFL+ game pages look like /games/49ers-at-cowboys-2026-reg-10.
  let lastAutoUrl = null;
  async function autoPickFromUrl() {
    let href = location.href;
    try { href = window.top.location.href; } catch { /* cross-origin frame */ }
    if (href === lastAutoUrl) return;
    lastAutoUrl = href;
    const m = /\/games\/([a-z0-9-]+?)-at-([a-z0-9-]+?)-(\d{4})-(reg|post)-(\d+)/i.exec(href);
    if (!m) return;
    const abbr = (nick) => Object.keys(NICK).find((k) => NICK[k] === nick.split('-').pop());
    const away = abbr(m[1].toLowerCase());
    const home = abbr(m[2].toLowerCase());
    const season = Number(m[3]);
    const week = Number(m[5]);
    if (!away || !home) return;
    if (state.game && state.game.home === home && state.game.away === away &&
        state.game.gameId.startsWith(String(season))) return;
    const r = await send({ type: 'getGames', season });
    const g = r?.ok && r.games.find((x) => x.home === home && x.away === away &&
      (m[4].toLowerCase() === 'post' || x.week === week));
    if (g) { state.picking = false; await storeSet({ activeGame: g }); toast(`Loaded ${g.away} at ${g.home}, Week ${g.week}`); }
  }

  timers.push(setInterval(() => {
    if (!alive()) return shutdown();
    const v = findVideo();
    if (v) { attach(v); autoPickFromUrl(); }
    else if (host && state.video && !state.video.isConnected) { host.remove(); state.video = null; }
  }, 1000));
  timers.push(setInterval(() => {
    if (!alive()) return shutdown();
    placeHost(); tick();
  }, 100));
  document.addEventListener('fullscreenchange', placeHost);
})();
