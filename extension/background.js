// Downloads public nflverse play-by-play data and caches it per game.
// Data source: https://github.com/nflverse/nflverse-data (pbp release, updated nightly).

const PBP_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;

const COLS = [
  'game_id', 'play_id', 'home_team', 'away_team', 'season_type', 'week', 'game_date',
  'posteam', 'defteam', 'qtr', 'time', 'down', 'ydstogo', 'yrdln', 'goal_to_go',
  'play_type', 'play_type_nfl', 'posteam_score', 'defteam_score', 'two_point_attempt', 'desc',
  'time_of_day', 'end_clock_time',
];

// Snaps that appear on film. Timeouts and administrative rows are dropped.
const KEEP_TYPES = new Set([
  'pass', 'run', 'punt', 'field_goal', 'kickoff', 'extra_point', 'qb_kneel', 'qb_spike', 'no_play',
]);
const DROP_NFL_TYPES = new Set(['TIMEOUT', 'END_QUARTER', 'GAME_START', 'END_GAME', 'COMMENT']);

const STALE_MS = 6 * 60 * 60 * 1000;

// Streaming CSV parser: feeds chunks, emits arrays of fields per record.
function makeCsvParser(onRecord) {
  let field = '';
  let record = [];
  let inQuotes = false;
  let pendingQuote = false; // saw a quote inside quotes; next char decides
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (inQuotes) {
          if (pendingQuote) {
            pendingQuote = false;
            if (c === '"') { field += '"'; continue; }
            inQuotes = false; // closing quote; fall through to normal handling
          } else if (c === '"') { pendingQuote = true; continue; }
          else { field += c; continue; }
        }
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { record.push(field); field = ''; }
        else if (c === '\n') { record.push(field); onRecord(record); record = []; field = ''; }
        else if (c !== '\r') { field += c; }
      }
    },
    end() {
      if (pendingQuote) { inQuotes = false; pendingQuote = false; }
      if (field !== '' || record.length) { record.push(field); onRecord(record); }
    },
  };
}

async function downloadSeason(season) {
  const res = await fetch(PBP_URL(season));
  if (!res.ok) throw new Error(`Play-by-play for ${season} is not available (HTTP ${res.status}).`);
  const stream = res.body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());

  let idx = null;
  const games = new Map(); // game_id -> { info, plays: [] }
  const parser = makeCsvParser((rec) => {
    if (!idx) {
      idx = {};
      for (const c of COLS) idx[c] = rec.indexOf(c);
      return;
    }
    const get = (c) => (idx[c] >= 0 ? rec[idx[c]] : '');
    const gid = get('game_id');
    if (!gid) return;
    let g = games.get(gid);
    if (!g) {
      g = {
        info: {
          gameId: gid, home: get('home_team'), away: get('away_team'),
          week: Number(get('week')), seasonType: get('season_type'), date: get('game_date'),
        },
        plays: [],
      };
      games.set(gid, g);
    }
    const type = get('play_type');
    if (!KEEP_TYPES.has(type) || DROP_NFL_TYPES.has(get('play_type_nfl'))) return;
    g.plays.push({
      id: get('play_id'),
      qtr: Number(get('qtr')),
      time: get('time'),
      down: get('down') ? Number(get('down')) : null,
      togo: Number(get('ydstogo')) || 0,
      yrdln: get('yrdln'),
      goalToGo: get('goal_to_go') === '1',
      pos: get('posteam'),
      def: get('defteam'),
      type,
      nflType: get('play_type_nfl'),
      twoPt: get('two_point_attempt') === '1',
      posScore: get('posteam_score') === '' ? null : Number(get('posteam_score')),
      defScore: get('defteam_score') === '' ? null : Number(get('defteam_score')),
      desc: get('desc'),
      // Wall-clock time of the snap and of the end of the play (UTC, ms precision).
      snapAt: get('time_of_day') ? Date.parse(get('time_of_day')) : null,
      endAt: get('end_clock_time') ? Date.parse(get('end_clock_time')) : null,
    });
  });

  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
  if (!idx || idx.game_id < 0) throw new Error('Unexpected play-by-play file format.');

  const index = [];
  const toStore = {};
  for (const [gid, g] of games) {
    g.info.playCount = g.plays.length;
    index.push(g.info);
    toStore[`plays:${gid}`] = g.plays;
  }
  index.sort((a, b) => a.week - b.week || a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId));
  toStore[`season:${season}`] = { fetchedAt: Date.now(), games: index };
  await chrome.storage.local.set(toStore);
  return index;
}

async function getGames(season, refresh) {
  const key = `season:${season}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && !refresh && Date.now() - cached.fetchedAt < STALE_MS) return cached.games;
  try {
    return await downloadSeason(season);
  } catch (err) {
    if (cached) return cached.games; // offline: fall back to what we have
    throw err;
  }
}

// Broadcast audio: one tab (the All-22 replay) drives a second tab (the full broadcast replay).
async function audioTabId() {
  return (await chrome.storage.session.get('audioTabId')).audioTabId ?? null;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await audioTabId())) chrome.storage.session.remove('audioTabId');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'setAudioTabSelf') {
    // From the on-page button: make the sending tab the audio source (or stop).
    (async () => {
      const old = await audioTabId();
      const me = sender.tab?.id;
      if (msg.on) await chrome.storage.session.set({ audioTabId: me });
      else if (old === me) await chrome.storage.session.remove('audioTabId');
      for (const id of new Set([old, me])) {
        if (id != null) chrome.tabs.sendMessage(id, { type: 'roleChanged' }).catch(() => {});
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'getAudioTab') {
    audioTabId().then((id) => sendResponse({ tabId: id }));
    return true;
  }
  if (msg?.type === 'whoami') {
    audioTabId().then((id) => sendResponse({ tabId: sender.tab?.id, isAudioTab: id != null && id === sender.tab?.id }));
    return true;
  }
  if (msg?.type === 'setAudioTab') {
    (async () => {
      const old = await audioTabId();
      if (msg.tabId == null) await chrome.storage.session.remove('audioTabId');
      else await chrome.storage.session.set({ audioTabId: msg.tabId });
      for (const id of new Set([old, msg.tabId])) {
        if (id != null) chrome.tabs.sendMessage(id, { type: 'roleChanged' }).catch(() => {});
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'relayKey') {
    if (sender.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'key', code: msg.code }).catch(() => {});
    return false;
  }
  if (msg?.type === 'audioStatus') {
    chrome.storage.session.get('driverTabId').then(({ driverTabId }) => {
      if (driverTabId != null && driverTabId !== sender.tab?.id) chrome.tabs.sendMessage(driverTabId, msg).catch(() => {});
    });
    return false;
  }
  if (msg?.type === 'audioDrive') {
    if (sender.tab?.id != null) chrome.storage.session.set({ driverTabId: sender.tab.id });
    audioTabId().then((id) => {
      if (id == null || id === sender.tab?.id) return;
      chrome.tabs.sendMessage(id, msg).catch(() => {});
    });
    return false;
  }
  if (msg?.type === 'getGames') {
    getGames(msg.season, msg.refresh)
      .then((games) => sendResponse({ ok: true, games }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // async response
  }
  return false;
});
