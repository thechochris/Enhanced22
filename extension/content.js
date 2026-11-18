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
    prefs: { overlay: true, list: true, sidelineOnly: true, broadcastAudio: true },
    anchors: [], // broadcast audio sync points: { w: snap wall-clock ms, b: broadcast video seconds }
    isAudioTab: false,
    lastDrive: null, // latest message from the All-22 tab (audio tab only)
    suppressSkipFor: null, // play index the user deliberately seeked into the end zone view of
    internalSeek: false,
  };

  // ---------- storage ----------
  const marksKey = () => `marks:${state.game.gameId}`;

  async function loadActiveGame() {
    const { activeGame, prefs } = await chrome.storage.local.get(['activeGame', 'prefs']);
    if (prefs) state.prefs = { ...state.prefs, ...prefs };
    if (!activeGame) { state.game = null; state.plays = []; renderList(); render(); return; }
    const pk = `plays:${activeGame.gameId}`;
    const mk = `marks:${activeGame.gameId}`;
    const data = await chrome.storage.local.get([pk, mk]);
    state.game = activeGame;
    state.plays = data[pk] || [];
    const saved = data[mk] || {};
    state.marks = saved.marks || {};
    state.history = saved.history || [];
    state.anchors = saved.anchors || [];
    renderList();
    render();
  }

  function saveMarks() {
    chrome.storage.local.set({
      [marksKey()]: { marks: state.marks, history: state.history, anchors: state.anchors },
    });
  }

  function savePrefs() {
    chrome.storage.local.set({ prefs: state.prefs });
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

  function seek(t) {
    if (!state.video) return;
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
    if (target != null) seek(markOf(target).s);
  }

  // ---------- skipping the end zone view ----------
  function tick() {
    const v = state.video;
    if (!v) return;
    if (!state.game) { renderStatus(v.currentTime, v); return; }
    const t = v.currentTime;
    const i = currentIndex(t);
    if (state.prefs.sidelineOnly && !v.paused && i >= 0 && state.suppressSkipFor !== i) {
      const seg = segment(i);
      if (seg && seg.end != null && seg.next != null && t >= seg.end && t < seg.next - 0.1) {
        seek(seg.next);
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
  function driveAudio(i, t) {
    if (state.isAudioTab || !state.prefs.broadcastAudio) return;
    const now = performance.now();
    if (now - lastDriveSent < 250) return;
    lastDriveSent = now;
    const p = i >= 0 ? state.plays[i] : null;
    const seg = i >= 0 ? segment(i) : null;
    // During the end zone view (when it isn't skipped) the broadcast audio of that play repeats.
    const since = seg && seg.end != null && t >= seg.end ? t - seg.end : t - (seg ? seg.s : 0);
    chrome.runtime.sendMessage({
      type: 'audioDrive',
      gameId: state.game.gameId,
      playIndex: i,
      w: p && p.snapAt ? p.snapAt + since * 1000 : null,
      playing: !!p && !state.video.paused,
      rate: state.video.playbackRate,
    }).catch(() => {});
  }

  function broadcastTimeFor(w) {
    if (!state.anchors.length || w == null) return null;
    const sorted = [...state.anchors].sort((a, b) => a.w - b.w);
    let a = sorted[0];
    for (const x of sorted) if (x.w <= w) a = x;
    return a.b + (w - a.w) / 1000;
  }

  function followAudio(msg) {
    state.lastDrive = msg;
    renderAudioBadge();
    const v = state.video;
    if (!v || !state.game || msg.gameId !== state.game.gameId) return;
    // While you're looking at and using this tab, hands off, so you can scrub and anchor.
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const b = broadcastTimeFor(msg.w);
    if (!msg.playing || b == null) { if (!v.paused) v.pause(); return; }
    v.muted = false;
    if (v.playbackRate !== msg.rate) v.playbackRate = msg.rate;
    if (Math.abs(v.currentTime - b) > 0.4) v.currentTime = b;
    if (v.paused) v.play().catch(() => {});
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
    el.audio.textContent =
      `Broadcast audio source · ${state.anchors.length} anchor${state.anchors.length === 1 ? '' : 's'}` +
      (p ? ` · Press B at the snap of ${E22.quarter(p.qtr)} ${E22.clock(p.time)} ${E22.typeLabel(p)}` +
        `${p.pos ? ` (${p.pos})` : ''}` : ' · Waiting for the All-22 tab') +
      ' · Switch back to the All-22 tab to play in sync';
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
    .audio { position: absolute; left: 12px; top: 12px; right: 12px; background: rgba(10,14,22,.85); color: #fff;
      border-radius: 8px; padding: 8px 12px; font-size: 13px; border-left: 3px solid #3ddc84; }
    .toast { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); background: rgba(0,0,0,.85);
      color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity .2s; }
    .toast.show { opacity: 1; }
    .audio:not(.hidden) ~ .toast { top: 60px; }
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
          <div class="l2"><span class="poss"></span><span class="score"></span><span class="badge"></span></div></div>
        <div class="sync hidden"></div>
        <div class="audio hidden"></div>
        <div class="toast"></div>
        <div class="panel">
          <header><div class="titlebar"><span class="grip" title="Drag to move">⠿</span><div class="title">Enhanced22</div>
              <button class="change" title="Choose a different game">Change game</button></div><div class="sub"></div>
            <div class="toggles">
              <label><input type="checkbox" data-pref="sidelineOnly"> Sideline view only</label>
              <label><input type="checkbox" data-pref="overlay"> Overlay</label>
              <label><input type="checkbox" data-pref="broadcastAudio"> Broadcast audio</label>
            </div>
            <div class="controls">
              <button data-act="mark" title="Press at the snap of the sideline view">Sync play (S)</button>
              <button data-act="skip" title="This play isn't in the replay">Not in replay (X)</button>
              <button data-act="undo">Undo (Z)</button>
              <button data-act="prev">◀ Prev (P)</button>
              <button data-act="next">Next (N) ▶</button>
            </div>
            <div class="status"></div></header>
          <div class="list"></div>
        </div>
      </div>`;
    for (const k of ['bug', 'sync', 'toast', 'panel', 'list', 'audio']) el[k] = root.querySelector(`.${k}`);
    el.clock = root.querySelector('.clock');
    el.dd = root.querySelector('.dd');
    el.yl = root.querySelector('.yl');
    el.poss = root.querySelector('.poss');
    el.score = root.querySelector('.score');
    el.badge = root.querySelector('.badge');
    el.title = root.querySelector('header .title');
    el.sub = root.querySelector('header .sub');
    el.status = root.querySelector('header .status');
    root.querySelector('header .change').addEventListener('click', () => { state.picking = true; renderList(); });
    makeDraggable(el.panel, root.querySelector('.panel header'), 'panelPos');
    makeDraggable(el.bug, el.bug, 'bugPos');
    el.controls = root.querySelector('header .controls');
    const ACTIONS = { mark: markNext, skip: skipNext, undo, prev: () => jump(-1), next: () => jump(1) };
    el.controls.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b || !state.video) return;
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
        toast('Moved this play\'s start to the current time');
        return;
      }
      if (!hasStart(i)) return;
      seek(markOf(i).s);
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
  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
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
      row.title = m?.skip ? 'Not in the replay' : typeof m?.s === 'number' ? 'Jump to this play' : 'Not synced yet';
      const t = document.createElement('span'); t.className = 't'; t.textContent = `${E22.quarter(p.qtr)} ${E22.clock(p.time)}`;
      const pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = p.pos || '';
      const ty = document.createElement('span'); ty.className = 'ty';
      ty.textContent = E22.typeLabel(p);
      const sit = document.createElement('span'); sit.className = 'sit';
      const dd = E22.downDistance(p);
      sit.textContent = dd && dd !== E22.typeLabel(p) ? ` · ${dd}` : '';
      ty.appendChild(sit);
      row.append(t, pos, ty);
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
    try { r = await chrome.runtime.sendMessage({ type: 'getGames', season }); } catch (e) { r = { ok: false, error: String(e) }; }
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
        chrome.storage.local.set({ activeGame: g });
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
        const x = Math.min(Math.max(e.clientX - dx - wrap.left, -start.width + 60), wrap.width - 60);
        const y = Math.min(Math.max(e.clientY - dy - wrap.top, 0), Math.max(0, wrap.height - Math.min(start.height, wrap.height * 0.75)));
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
    el.panel.style.height = state.prefs.panelPos ? '75%' : '';
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
    const txt = `Video ${fmt(t)} / ${fmt(v.duration)} · ${v.paused ? 'paused' : 'playing'}`;
    if (txt !== lastStatus) { lastStatus = txt; el.status.textContent = txt; }
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
      state.prefs.sidelineOnly = !state.prefs.sidelineOnly; savePrefs(); render();
      toast(state.prefs.sidelineOnly ? 'Sideline view only' : 'Showing both camera angles');
    },
  };
  const AUDIO_KEYS = { KeyB: addAnchor, KeyU: removeLastAnchor };
  function handleKey(code) {
    if (!state.video || !state.game) return false;
    const fn = (state.isAudioTab ? AUDIO_KEYS : KEYS)[code];
    if (!fn) return false;
    fn();
    return true;
  }
  window.addEventListener('keydown', (ev) => {
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
      chrome.runtime.sendMessage({ type: 'relayKey', code: ev.code }).catch(() => {});
    }
  }, true);

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

  function attach(v) {
    if (state.video === v) return;
    if (state.video) state.video.removeEventListener('seeked', onSeeked);
    state.video = v;
    v.addEventListener('seeked', onSeeked);
    if (!host) { buildUi(); loadActiveGame().then(checkRole); }
    placeHost();
  }

  async function checkRole() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'whoami' });
      const was = state.isAudioTab;
      state.isAudioTab = !!r?.isAudioTab;
      if (was !== state.isAudioTab) render();
    } catch { /* extension reloaded */ }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'audioDrive' && state.isAudioTab) followAudio(msg);
    if (msg?.type === 'roleChanged') checkRole();
    if (msg?.type === 'key' && state.video) handleKey(msg.code);
  });

  setInterval(() => {
    const v = findVideo();
    if (v) attach(v);
    else if (host && state.video && !state.video.isConnected) { host.remove(); state.video = null; }
  }, 1000);
  setInterval(() => { placeHost(); tick(); }, 100);
  document.addEventListener('fullscreenchange', placeHost);
})();
