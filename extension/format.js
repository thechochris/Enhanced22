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

  return { typeLabel, quarter, clock, downDistance, yardLine, score };
})();
