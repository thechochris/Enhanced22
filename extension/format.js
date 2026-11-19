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
    if (p.int) parts.push('INT');
    if (p.fumLost) parts.push('Fumble lost');
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
    ARI: '#97233F', ATL: '#A71930', BAL: '#241773', BUF: '#00338D', CAR: '#0085CA', CHI: '#C83803',
    CIN: '#FB4F14', CLE: '#FF3C00', DAL: '#003594', DEN: '#FB4F14', DET: '#0076B6', GB: '#203731',
    HOU: '#A71930', IND: '#002C5F', JAX: '#006778', KC: '#E31837', LA: '#003594', LAC: '#0080C6',
    LV: '#A5ACAF', MIA: '#008E97', MIN: '#4F2683', NE: '#C60C30', NO: '#D3BC8D', NYG: '#0B2265',
    NYJ: '#125740', PHI: '#004C54', PIT: '#FFB612', SEA: '#69BE28', SF: '#AA0000', TB: '#D50A0A',
    TEN: '#4B92DB', WAS: '#5A1414',
  };
  const teamColor = (t) => TEAM_COLORS[t] || '#5b667d';

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
  // Words that describe a play, for the search box.
  function searchText(p) {
    const k = kick(p);
    const words = [
      typeLabel(p), p.desc, details(p), quarter(p.qtr), clock(p.time),
      p.td && 'touchdown td', p.int && 'interception int pick', p.fumLost && 'fumble',
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

  return { matches, searchText, kick, typeLabel, quarter, clock, downDistance, yardLine, score, scores, teamColor, details };
})();
