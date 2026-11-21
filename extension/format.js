// Shared display helpers (loaded by both the content script and the popup).
/* exported E22 */
var E22 = (function () {
  const TYPE_LABELS = {
    pass: 'Pass', run: 'Run', punt: 'Punt', field_goal: 'Field goal', kickoff: 'Kickoff',
    extra_point: 'Extra point', qb_kneel: 'Kneel', qb_spike: 'Spike', no_play: 'Penalty',
  };

  function typeLabel(p) {
    if (p.twoPt) return '2-pt try';
    if (p.type === 'pass' && p.nflType === 'SACK') return 'Pass (sack)';
    return TYPE_LABELS[p.type] || p.type;
  }

  function quarter(q) {
    return q >= 5 ? (q === 5 ? 'OT' : `${q - 4}OT`) : `Q${q}`;
  }

  function clock(t) {
    return (t || '').replace(/^0(\d)/, '$1');
  }

  function ordinal(n) {
    return ['', '1st', '2nd', '3rd', '4th'][n] || `${n}th`;
  }

  function downDistance(p) {
    if (p.type === 'kickoff') return 'Kickoff';
    if (p.type === 'extra_point') return 'PAT';
    if (p.twoPt) return '2-pt try';
    if (!p.down) return '';
    return `${ordinal(p.down)} & ${p.goalToGo ? 'Goal' : p.togo}`;
  }

  function yardLine(p) {
    const y = p.yrdln || '';
    return /\b50$/.test(y) ? '50' : y;
  }

  function score(p, game) {
    if (p.posScore == null || !p.pos || !game) return '';
    const homeHasBall = p.pos === game.home;
    const home = homeHasBall ? p.posScore : p.defScore;
    const away = homeHasBall ? p.defScore : p.posScore;
    return `${game.away} ${away} – ${game.home} ${home}`;
  }

  function yds(n) {
    return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} yd${Math.abs(n) === 1 ? '' : 's'}`;
  }

  // "Penalty: Defensive Holding on DAL (K.Clark), 5 yds", or "... declined" / "offsetting".
  function penaltyText(p) {
    const x = p.pen;
    if (!x) return '';
    const who = x.team ? ` on ${x.team}${x.player ? ` (${x.player})` : ''}` : '';
    const how = x.offsetting ? ', offsetting' : x.declined ? ', declined' : x.yards != null ? `, ${x.yards} yd${x.yards === 1 ? '' : 's'}` : '';
    return `Penalty: ${x.type}${who}${how}`;
  }

  // A field goal or extra point: who kicked, from how far, and how it went. Data saved before
  // these fields existed falls back to the play description ("18-E.Pineiro 28 yard field goal
  // is GOOD").
  function kick(p) {
    if (p.type !== 'field_goal' && p.type !== 'extra_point') return null;
    const d = p.desc || '';
    const fg = p.type === 'field_goal';
    let kicker = p.kicker || null;
    let dist = p.kickDist ?? null;
    let result = fg ? p.fgResult : p.xpResult;
    const m = fg ? d.match(/(?:\d+-)?([A-Z][A-Za-z'.-]*\.[A-Za-z'.-]+) (\d+) yard field goal is (GOOD|No Good|BLOCKED)/i)
      : d.match(/(?:\d+-)?([A-Z][A-Za-z'.-]*\.[A-Za-z'.-]+) extra point is (GOOD|No Good|Blocked|Aborted)/i);
    if (m) {
      kicker = kicker || m[1];
      if (fg && dist == null) dist = Number(m[2]);
      if (!result) {
        const r = (fg ? m[3] : m[2]).toLowerCase();
        result = r === 'good' ? (fg ? 'made' : 'good') : r === 'blocked' ? 'blocked' : fg ? 'missed' : 'failed';
      }
    }
    if (!kicker && !result) return null;
    const good = result === 'made' || result === 'good';
    const outcome = good ? 'Good' : result === 'blocked' ? 'Blocked' : result ? 'No good' : '';
    return { kicker, dist, good, blocked: result === 'blocked', outcome, fg };
  }

  // Who had the ball and the result, e.g. "B.Purdy → G.Kittle · +20 yds".
  // Penalties that wiped out the play show the players but no yards.
  function details(p) {
    if (p.yards === undefined && !kick(p)) return ''; // data downloaded before this was added
    const parts = [];
    const counted = p.type !== 'no_play';
    const k = kick(p);
    if (k) {
      parts.push([k.kicker, k.fg ? (k.dist ? `${k.dist}-yd field goal` : 'field goal') : 'extra point'].filter(Boolean).join(' '));
      if (k.outcome) parts.push(k.outcome);
      const pen = penaltyText(p);
      if (pen) parts.push(pen);
      return parts.join(' · ');
    }
    if (p.type === 'pass' || (p.type === 'no_play' && p.passer)) {
      if (p.sack) parts.push(`${p.passer || 'QB'} sacked${p.sackedBy?.length ? ` by ${p.sackedBy.join(' & ')}` : ''}`);
      else if (p.rusher && !p.receiver) parts.push(`${p.rusher} scramble`);
      else if (p.passer) parts.push(p.receiver ? `${p.passer} → ${p.receiver}` : p.passer);
      if (p.inc && !p.int) parts.push('incomplete');
    } else if (p.type === 'no_play' && /\b([A-Z]\.[A-Za-z'.-]+) sacked\b/.test(p.desc || '')) {
      parts.push(`${RegExp.$1} sacked (wiped out by the penalty)`);
    } else if (p.rusher) {
      parts.push(p.rusher);
    } else if ((p.type === 'kickoff' || p.type === 'punt') && p.returner) {
      parts.push(`${p.returner} return`);
      if (p.retYards != null && counted) parts.push(yds(p.retYards).replace('+', ''));
    }
    if (counted && p.yards != null && !p.inc && !p.int && (p.type === 'pass' || p.type === 'run' || p.type === 'qb_kneel')) {
      parts.push(yds(p.yards));
    }
    // Interceptions and lost fumbles show as their own red tag (turnover).
    const pen = penaltyText(p);
    if (pen) parts.push(pen);
    return parts.join(' · ');
  }

  // Score before the play, as { home, away } (null when unknown).
  function scores(p, game) {
    if (p.posScore == null || !p.pos || !game) return { home: null, away: null };
    const homeHasBall = p.pos === game.home;
    return { home: homeHasBall ? p.posScore : p.defScore, away: homeHasBall ? p.defScore : p.posScore };
  }

  const TEAM_COLORS = {
    ARI: '#97233F', ATL: '#A71930', BAL: '#241773', BUF: '#00338D', CAR: '#0085CA', CHI: '#0B162A',
    CIN: '#000000', CLE: '#311D00', DAL: '#003594', DEN: '#002244', DET: '#0076B6', GB: '#203731',
    HOU: '#A71930', IND: '#002C5F', JAX: '#006778', KC: '#E31837', LA: '#003594', LAC: '#0080C6',
    LV: '#000000', MIA: '#008E97', MIN: '#4F2683', NE: '#C60C30', NO: '#101820', NYG: '#0B2265',
    NYJ: '#125740', PHI: '#004C54', PIT: '#101820', SEA: '#002244', SF: '#AA0000', TB: '#D50A0A',
    TEN: '#0C2340', WAS: '#5A1414',
  };
  // Second team colors, picked to show against the first: where a team's accent would vanish
  // (dark on dark), it gets its next one, and teams whose main color is dark (Bears navy,
  // Steelers black...) use it as the fill with their bright color as the accent.
  const TEAM_COLORS2 = {
    ARI: '#FFB612', ATL: '#A5ACAF', BAL: '#9E7C0C', BUF: '#C60C30', CAR: '#BFC0BF', CHI: '#C83803',
    CIN: '#FB4F14', CLE: '#FF3C00', DAL: '#869397', DEN: '#FB4F14', DET: '#B0B7BC', GB: '#FFB612',
    HOU: '#FFFFFF', IND: '#A2AAAD', JAX: '#D7A22A', KC: '#FFB81C', LA: '#FFA300', LAC: '#FFC20E',
    LV: '#A5ACAF', MIA: '#FC4C02', MIN: '#FFC62F', NE: '#B0B7BC', NO: '#D3BC8D', NYG: '#A71930',
    NYJ: '#FFFFFF', PHI: '#A5ACAF', PIT: '#FFB612', SEA: '#69BE28', SF: '#B3995D', TB: '#FF7900',
    TEN: '#4B92DB', WAS: '#FFB612',
  };
  const teamColor = (t) => TEAM_COLORS[t] || '#5b667d';
  const teamColor2 = (t) => TEAM_COLORS2[t] || '#9aa6bd';
  // White text like the TD tag, unless the color is too light for it.
  const lum = (hex) => {
    const h = hex.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return [r, g, b];
  };
  function inkOn(hex) {
    const [r, g, b] = lum(hex);
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return 1.05 / (L + 0.05) >= 3 ? '#fff' : '#111';
  }
  const teamInk = (t) => inkOn(teamColor(t));
  // How different two colors look (CIE Lab distance; under about 25 reads as "the same color").
  function colorDistance(a, b) {
    const lab = (hex) => {
      const [r, g, bl] = lum(hex);
      const f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
      const X = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047);
      const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl);
      const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
      return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
    };
    const [x, y] = [lab(a), lab(b)];
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }
  const SAME = 25;
  // Colors for both teams in one game: { [team]: { fill, accent, ink } }. When the two main
  // colors look alike (Cowboys and Rams blue, say), the away team flips to its second color
  // as the fill, with its main color as the accent; if that still clashes, it goes white.
  function gameColors(game) {
    const out = {};
    if (!game) return out;
    const pick = (t) => ({ fill: teamColor(t), accent: teamColor2(t) });
    const home = pick(game.home);
    let away = pick(game.away);
    if (colorDistance(home.fill, away.fill) < SAME) {
      away = { fill: away.accent, accent: away.fill, flipped: true };
      if (colorDistance(home.fill, away.fill) < SAME || colorDistance('#151b27', away.fill) < 12) away = { fill: '#FFFFFF', accent: teamColor(game.away), flipped: true };
    }
    for (const [t, c] of [[game.home, home], [game.away, away]]) out[t] = { ...c, ink: inkOn(c.fill) };
    return out;
  }
  // One team's colors, using the game's (flipped) colors when that team is playing in it.
  function colorsFor(t, game) {
    const g = gameColors(game);
    return g[t] || { fill: teamColor(t), accent: teamColor2(t), ink: teamInk(t) };
  }

  const TEAM_NAMES = {
    ARI: 'cardinals arizona', ATL: 'falcons atlanta', BAL: 'ravens baltimore', BUF: 'bills buffalo',
    CAR: 'panthers carolina', CHI: 'bears chicago', CIN: 'bengals cincinnati', CLE: 'browns cleveland',
    DAL: 'cowboys dallas', DEN: 'broncos denver', DET: 'lions detroit', GB: 'packers green bay',
    HOU: 'texans houston', IND: 'colts indianapolis', JAX: 'jaguars jacksonville', KC: 'chiefs kansas city',
    LA: 'rams los angeles', LAC: 'chargers los angeles', LV: 'raiders las vegas', MIA: 'dolphins miami',
    MIN: 'vikings minnesota', NE: 'patriots new england', NO: 'saints new orleans', NYG: 'giants new york',
    NYJ: 'jets new york', PHI: 'eagles philadelphia', PIT: 'steelers pittsburgh', SEA: 'seahawks seattle',
    SF: '49ers niners san francisco', TB: 'buccaneers bucs tampa bay', TEN: 'titans tennessee',
    WAS: 'commanders washington',
  };
  // A takeaway on the play: 'INT' or 'FUMBLE' (the ball changed hands), else null.
  function turnover(p) {
    if (p.int) return 'INT';
    if (p.fumLost) return 'FUMBLE';
    return null;
  }
  // Words that describe a play, for the search box.
  function searchText(p) {
    const k = kick(p);
    const words = [
      typeLabel(p), p.desc, details(p), quarter(p.qtr), clock(p.time),
      p.td && 'touchdown td', p.int && 'interception int pick', p.fumLost && 'fumble fumble lost', turnover(p) && 'turnover takeaway giveaway',
      p.sack && 'sack', p.pen && 'penalty flag', p.inc && 'incomplete',
      p.type === 'field_goal' && 'field goal fg', p.type === 'extra_point' && 'extra point pat xp',
      k && (k.good ? 'good made' : k.blocked ? 'blocked' : 'no good missed miss'),
      p.twoPt && 'two point 2pt conversion', p.type === 'pass' && 'pass passing', p.type === 'run' && 'run rush rushing',
    ];
    return words.filter(Boolean).join(' ').toLowerCase();
  }
  // Does a play match the search? Every word must appear. A team (SF, 49ers, Cowboys...)
  // means plays where that team had the ball.
  function matches(p, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = searchText(p);
    let i = 0;
    while (i < words.length) {
      // Two-word team names first ("green bay", "san francisco").
      const two = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : null;
      const team = (w) => Object.keys(TEAM_NAMES).filter((t) => t.toLowerCase() === w || TEAM_NAMES[t].split(' ').includes(w) || (w.includes(' ') && TEAM_NAMES[t].includes(w)));
      let ts = two ? team(two) : [];
      let used = ts.length ? 2 : 1;
      if (!ts.length) ts = team(words[i]);
      if (ts.length) {
        if (!ts.includes(p.pos)) return false;
      } else if (!text.includes(words[i])) return false;
      i += used;
    }
    return true;
  }

  return { turnover, teamColor2, teamInk, gameColors, colorsFor, colorDistance, matches, searchText, kick, typeLabel, quarter, clock, downDistance, yardLine, score, scores, teamColor, details };
})();
