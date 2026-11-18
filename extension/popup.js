const $ = (id) => document.getElementById(id);

// NFL seasons start in September; before then, default to last season.
const now = new Date();
const currentSeason = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;

for (let y = currentSeason; y >= 2016; y--) {
  const o = document.createElement('option');
  o.value = o.textContent = y;
  $('season').appendChild(o);
}

async function showActive() {
  const { activeGame } = await chrome.storage.local.get('activeGame');
  if (!activeGame) return null;
  const mk = `marks:${activeGame.gameId}`;
  const marks = ((await chrome.storage.local.get(mk))[mk] || {}).marks || {};
  const synced = Object.values(marks).filter((m) => typeof m.s === 'number').length;
  $('active').textContent =
    `Active: ${activeGame.away} at ${activeGame.home}, Week ${activeGame.week} · ${synced} of ${activeGame.playCount} plays synced`;
  return activeGame;
}

async function load(refresh = false) {
  const season = Number($('season').value);
  $('status').textContent = refresh || !(await hasCache(season))
    ? 'Downloading play-by-play (about 10 MB)…' : '';
  const r = await chrome.runtime.sendMessage({ type: 'getGames', season, refresh });
  if (!r.ok) { $('status').textContent = r.error; return; }
  $('status').textContent = `${r.games.length} games`;
  const active = await showActive();
  const list = $('games');
  list.innerHTML = '';
  let wk = null;
  for (const g of [...r.games].reverse()) { // newest week first
    if (g.week !== wk) {
      wk = g.week;
      const h = document.createElement('div');
      h.className = 'wk';
      h.textContent = g.seasonType === 'POST' ? `Playoffs · Week ${wk}` : `Week ${wk}`;
      list.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = `game${active?.gameId === g.gameId ? ' active' : ''}`;
    const name = document.createElement('span');
    name.textContent = `${g.away} at ${g.home}`;
    const date = document.createElement('span');
    date.className = 'muted';
    date.textContent = g.date;
    row.append(name, date);
    row.addEventListener('click', async () => {
      await chrome.storage.local.set({ activeGame: g });
      load();
    });
    list.appendChild(row);
  }
}

async function hasCache(season) {
  return !!(await chrome.storage.local.get(`season:${season}`))[`season:${season}`];
}

async function showAudio() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { tabId } = await chrome.runtime.sendMessage({ type: 'getAudioTab' });
  const isThis = tabId != null && tabId === tab?.id;
  $('audioStatus').textContent = tabId == null ? 'Broadcast audio: no source tab'
    : isThis ? 'This tab is the broadcast audio source' : 'Broadcast audio: another tab is the source';
  $('audioBtn').textContent = isThis ? 'Stop using this tab' : 'Use this tab';
  $('audioBtn').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'setAudioTab', tabId: isThis ? null : tab.id });
    showAudio();
  };
}

$('season').addEventListener('change', () => load());
$('refresh').addEventListener('click', () => load(true));
load();
showAudio();
