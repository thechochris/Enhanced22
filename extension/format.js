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

  // Who had the ball and the result, e.g. "B.Purdy → G.Kittle · +20 yds".
  // Penalties that wiped out the play show the players but no yards.
  function details(p) {
    if (p.yards === undefined) return ''; // data downloaded before this was added
    const parts = [];
    const counted = p.type !== 'no_play';
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

  return { typeLabel, quarter, clock, downDistance, yardLine, score, scores, teamColor, details };
})();
