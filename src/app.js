/**
 * FRC Schedule Builder
 *
 * Loads team count from The Blue Alliance API and finds the event agenda
 * PDF linked from the TBA agenda page.  Users enter qual time manually.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const TBA_BASE    = 'https://www.thebluealliance.com/api/v3';
const TBA_API_KEY = 'OgkQlossATyHZij8FEAKl0opKiW63fDDSf7Fcwnr9jcJON5XwiGHgmCVZvjFb1Lv';

/**
 * Primary CORS proxy: allorigins returns
 *   { status: { url, content_type, http_code }, contents: "<body>" }
 */
const ALLORIGINS = 'https://api.allorigins.win/get?url=';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Fetch JSON from the TBA v3 API. */
async function tbaFetch(path) {
  const response = await fetch(`${TBA_BASE}${path}`, {
    headers: { 'X-TBA-Auth-Key': TBA_API_KEY },
  });
  if (!response.ok) {
    throw new Error(`TBA API returned ${response.status} for ${path}`);
  }
  return response.json();
}

/** Fetch a URL via the allorigins CORS proxy. */
async function proxiedFetch(url) {
  const proxyUrl = `${ALLORIGINS}${encodeURIComponent(url)}`;
  const response = await fetch(proxyUrl);
  if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
  return response.json();           // { status: {url, ...}, contents: string }
}

/**
 * Load the event agenda by following the TBA redirect:
 *   https://www.thebluealliance.com/event/<key>/agenda
 *
 * Returns { qualMinutes, source, agendaUrl } where:
 *   qualMinutes – detected qual-match duration in minutes (null if not found)
 *   source      – human-readable description of what was found
 *   agendaUrl   – the final URL the agenda redirected to
 *
 * Note: the TBA API key is intentionally included here because this is a
 * client-side SPA with no backend.  TBA API keys are public, rate-limited
 * credentials — not secrets.
 *
 * @param {string} eventKey
 * @returns {Promise<{qualMinutes:number|null, source:string, agendaUrl:string|null}>}
 */
export async function loadAgendaInfo(eventKey) {
  const agendaUrl = `https://www.thebluealliance.com/event/${eventKey}/agenda`;

  let data;
  try {
    data = await proxiedFetch(agendaUrl);
  } catch (err) {
    return { qualMinutes: null, source: `Could not fetch agenda: ${err.message}`, agendaUrl: null };
  }

  const finalUrl    = data.status?.url          ?? agendaUrl;
  const content     = data.contents             ?? '';
  const contentType = data.status?.content_type ?? '';

  // ── 1. Did the proxy land on a PDF? ────────────────────────────────────
  if (contentType.includes('application/pdf') || /\.pdf(\?|#|$)/i.test(finalUrl)) {
    return {
      qualMinutes: null,
      source: 'Agenda is a PDF — please enter qual time manually',
      agendaUrl: finalUrl,
    };
  }

  // ── 2. Is there a PDF link embedded in the page HTML? ───────────────────
  const pdfMatch = content.match(/https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/i);
  if (pdfMatch) {
    return {
      qualMinutes: null,
      source: 'Agenda is a PDF — please enter qual time manually',
      agendaUrl: pdfMatch[0],
    };
  }

  // ── 3. No recognizable agenda found ────────────────────────────────────
  return {
    qualMinutes: null,
    source: 'No agenda document found — please enter qual time manually',
    agendaUrl: finalUrl !== agendaUrl ? finalUrl : null,
  };
}

// ── Schedule maths ─────────────────────────────────────────────────────────

/**
 * Calculate qualification match schedule statistics.
 *
 * FRC qual matches are 3v3 (6 team slots per match).  If the total number of
 * team-plays (teams × matchesPerTeam) is not divisible by 6, extra "surrogate"
 * plays are added so that every match slot is filled.
 *
 * @param {Object} p
 * @param {number} p.numTeams
 * @param {number} p.matchesPerTeam
 * @param {number} p.cycleTimeMin  – minutes per match (including setup/reset)
 * @param {number} p.qualTimeMin   – total minutes available for qual matches
 * @returns {{
 *   totalPlays: number,
 *   surrogates: number,
 *   totalMatches: number,
 *   timeNeededMin: number,
 *   timeAvailableMin: number,
 *   deltaMin: number,
 *   fits: boolean
 * }}
 */
export function calculateSchedule({ numTeams, matchesPerTeam, cycleTimeMin, qualTimeMin }) {
  const basePlays   = numTeams * matchesPerTeam;
  const remainder   = basePlays % 6;
  const surrogates  = remainder === 0 ? 0 : 6 - remainder;
  const totalPlays  = basePlays + surrogates;
  const totalMatches = totalPlays / 6;  // always integer

  const timeNeededMin = totalMatches * cycleTimeMin;
  const deltaMin      = qualTimeMin - timeNeededMin;

  return {
    totalPlays,
    surrogates,
    totalMatches,
    timeNeededMin,
    timeAvailableMin: qualTimeMin,
    deltaMin,
    fits: deltaMin >= 0,
  };
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showEl(id)  { $(id).classList.remove('hidden'); }
function hideEl(id)  { $(id).classList.add('hidden'); }

function setStatus(msg) {
  showEl('load-status');
  $('load-status-text').textContent = msg;
}
function clearStatus() { hideEl('load-status'); }

function showError(msg) {
  const el = $('load-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError() { hideEl('load-error'); }

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

// ── Event load ─────────────────────────────────────────────────────────────

let _teamCount = null;

async function handleLoadEvent() {
  const eventKey = $('event-key').value.trim();
  if (!eventKey) {
    showError('Please enter an event key.');
    return;
  }

  clearError();
  setStatus('Fetching team list from The Blue Alliance…');
  $('load-btn').disabled = true;
  hideEl('params-card');
  hideEl('results-card');

  try {
    // ── Fetch teams ──────────────────────────────────────────────────────
    const teams = await tbaFetch(`/event/${eventKey}/teams/simple`);
    _teamCount  = teams.length;

    if (_teamCount === 0) {
      showError(`No teams found for event "${eventKey}". Check the key and try again.`);
      clearStatus();
      $('load-btn').disabled = false;
      return;
    }

    // ── Fetch agenda ─────────────────────────────────────────────────────
    setStatus('Loading event agenda…');
    const agenda = await loadAgendaInfo(eventKey);

    // Populate event info tiles
    $('event-info-grid').innerHTML = `
      <div class="info-tile">
        <div class="tile-value">${_teamCount}</div>
        <div class="tile-label">Teams Registered</div>
      </div>
      <div class="info-tile">
        <div class="tile-value">${agenda.qualMinutes !== null ? formatMinutes(agenda.qualMinutes) : '—'}</div>
        <div class="tile-label">Detected Qual Time</div>
      </div>
      ${agenda.agendaUrl ? `
      <div class="info-tile" style="grid-column: 1 / -1; text-align: left;">
        <div class="tile-label">Agenda Source</div>
        <a href="${encodeURI(agenda.agendaUrl)}" target="_blank" rel="noopener"
           style="font-size:.85rem; word-break:break-all;">${agenda.agendaUrl}</a>
      </div>` : ''}
    `;

    // Agenda detection alert
    const agendaAlert = $('agenda-alert');
    if (agenda.qualMinutes !== null) {
      agendaAlert.className = 'alert alert-success';
      agendaAlert.textContent = `✔ ${agenda.source}`;
      $('qual-time').value = agenda.qualMinutes;
      const badge = $('qual-time-badge');
      badge.textContent = 'auto-detected';
      badge.style.display = 'inline';
    } else {
      agendaAlert.className = 'alert alert-warn';
      agendaAlert.textContent = `⚠ ${agenda.source}`;
      $('qual-time').value = '';
      $('qual-time-badge').style.display = 'none';
    }
    agendaAlert.classList.remove('hidden');

    showEl('params-card');
    clearStatus();

  } catch (err) {
    showError(`Failed to load event: ${err.message}`);
    clearStatus();
  } finally {
    $('load-btn').disabled = false;
  }
}

// ── Calculate ──────────────────────────────────────────────────────────────

function handleCalculate() {
  const matchesPerTeam = parseFloat($('matches-per-team').value);
  const cycleTimeMin   = parseFloat($('cycle-time').value);
  const qualTimeMin    = parseFloat($('qual-time').value);

  if (!_teamCount || isNaN(matchesPerTeam) || isNaN(cycleTimeMin) || isNaN(qualTimeMin)) {
    alert('Please fill in all schedule parameter fields.');
    return;
  }
  if (qualTimeMin <= 0 || cycleTimeMin <= 0 || matchesPerTeam <= 0) {
    alert('All values must be greater than zero.');
    return;
  }

  const s = calculateSchedule({
    numTeams: _teamCount,
    matchesPerTeam,
    cycleTimeMin,
    qualTimeMin,
  });

  const usagePct = Math.min(100, (s.timeNeededMin / s.timeAvailableMin) * 100).toFixed(1);
  const barColor = s.fits
    ? (usagePct < 85 ? '#16a34a' : '#d97706')
    : '#dc2626';

  const verdictClass = s.fits
    ? (s.deltaMin === 0 ? 'fit-exact' : 'fit-ok')
    : 'fit-over';
  const verdictIcon = s.fits ? '✔' : '✗';
  const verdictText = s.fits
    ? `Schedule fits with ${formatMinutes(s.deltaMin)} to spare`
    : `Schedule runs ${formatMinutes(Math.abs(s.deltaMin))} over the allotted time`;

  const surrogateNote = s.surrogates > 0
    ? `<div class="surrogate-note">
        ⚠ <strong>${s.surrogates} surrogate${s.surrogates > 1 ? 's' : ''}</strong>
        added to fill match slots evenly (${_teamCount} teams × ${matchesPerTeam} matches
        = ${s.totalPlays - s.surrogates} plays → next multiple of 6).
       </div>`
    : '';

  $('results-content').innerHTML = `
    <div class="results-grid">
      <div class="result-tile">
        <div class="tile-value">${_teamCount}</div>
        <div class="tile-label">Teams</div>
      </div>
      <div class="result-tile">
        <div class="tile-value">${s.totalMatches}</div>
        <div class="tile-label">Total Qual Matches</div>
      </div>
      <div class="result-tile">
        <div class="tile-value">${formatMinutes(s.timeNeededMin)}</div>
        <div class="tile-label">Time Needed</div>
      </div>
      <div class="result-tile">
        <div class="tile-value">${formatMinutes(s.timeAvailableMin)}</div>
        <div class="tile-label">Time Available</div>
      </div>
    </div>

    <div class="fit-bar-wrap">
      <div class="fit-bar-labels">
        <span>0</span>
        <span>Time used: ${usagePct}%</span>
        <span>${formatMinutes(s.timeAvailableMin)}</span>
      </div>
      <div class="fit-bar-track">
        <div class="fit-bar-fill"
             style="width:${usagePct}%; background:${barColor};"></div>
      </div>
    </div>

    <div class="fit-verdict ${verdictClass}">
      <span>${verdictIcon}</span>
      <span>${verdictText}</span>
    </div>

    ${surrogateNote}

    <details style="margin-top:1.25rem; font-size:.875rem;">
      <summary style="cursor:pointer; font-weight:600; color:var(--gray);">Calculation details</summary>
      <table style="margin-top:.75rem; border-collapse:collapse; width:100%;">
        ${tableRow('Teams', _teamCount)}
        ${tableRow('Matches per team', matchesPerTeam)}
        ${tableRow('Base team-plays', `${_teamCount} × ${matchesPerTeam} = ${_teamCount * matchesPerTeam}`)}
        ${tableRow('Surrogates needed', s.surrogates)}
        ${tableRow('Total team-plays (incl. surrogates)', s.totalPlays)}
        ${tableRow('Total matches (÷ 6 slots)', s.totalMatches)}
        ${tableRow('Cycle time', `${cycleTimeMin} min`)}
        ${tableRow('Time needed', formatMinutes(s.timeNeededMin))}
        ${tableRow('Time available (from agenda)', formatMinutes(s.timeAvailableMin))}
        ${tableRow('Difference', `${s.fits ? '+' : '−'}${formatMinutes(Math.abs(s.deltaMin))}`)}
      </table>
    </details>
  `;

  showEl('results-card');
  $('results-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function tableRow(label, value) {
  return `
    <tr>
      <td style="padding:.3rem .5rem; color:var(--gray); border-bottom:1px solid var(--border);">${label}</td>
      <td style="padding:.3rem .5rem; font-weight:600; border-bottom:1px solid var(--border);">${value}</td>
    </tr>`;
}

// ── Wire up events ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $('load-btn').addEventListener('click', handleLoadEvent);
  $('event-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLoadEvent();
  });
  $('calculate-btn').addEventListener('click', handleCalculate);

  // When the user edits the qual-time field manually, remove the "auto" badge
  $('qual-time').addEventListener('input', () => {
    $('qual-time-badge').textContent = 'edited';
  });
});
