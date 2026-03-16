/**
 * FRC Schedule Builder
 *
 * Loads team count from The Blue Alliance API, fetches the agenda PDF
 * directly from FIRST Inspires, parses it with PDF.js to auto-detect
 * the qual-match time block, and lets users override the value if needed.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const TBA_BASE    = 'https://www.thebluealliance.com/api/v3';
const TBA_API_KEY = 'OgkQlossATyHZij8FEAKl0opKiW63fDDSf7Fcwnr9jcJON5XwiGHgmCVZvjFb1Lv';

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

// ── PDF / time parsing ─────────────────────────────────────────────────────

/**
 * Convert a time string like "10:30 AM", "14:30", or "2:30 PM" into minutes
 * since midnight.  Returns null if the string is not a recognizable time.
 * @param {string} str
 * @returns {number|null}
 */
function parseTimeMinutes(str) {
  if (!str) return null;
  str = str.trim();

  // 12-hour format: "10:30 AM" / "2:30 PM"
  const m12 = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const m = parseInt(m12[2], 10);
    const p = m12[3].toUpperCase();
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }

  // 24-hour format: "14:30"
  const m24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const m = parseInt(m24[2], 10);
    if (h <= 23 && m <= 59) return h * 60 + m;
  }

  return null;
}

/**
 * Given an array of cell strings, return the duration in minutes inferred
 * from the minimum and maximum valid time values found among them.
 * Returns null if fewer than two valid times are found.
 * @param {string[]} cells
 * @returns {number|null}
 */
function rowDurationMinutes(cells) {
  const times = cells.map(parseTimeMinutes).filter(t => t !== null);
  if (times.length < 2) return null;
  const duration = Math.max(...times) - Math.min(...times);
  // Sanity: ignore unrealistic values (> 12 h or ≤ 0)
  return duration > 0 && duration <= 720 ? duration : null;
}

/**
 * Parse an array of PDF.js text items and sum up all time blocks whose row
 * text contains "qual" or "qualification" (case-insensitive).
 *
 * Items are grouped into rows by their Y position (transform[5]), then each
 * row is checked for a qual label and parseable start/end times.
 *
 * If a qual row contains no parseable times (e.g. the activity label and time
 * columns sit on slightly different baselines in the PDF), up to two adjacent
 * rows are merged with it to recover the times.
 *
 * @param {Array<{str: string, transform: number[]}>} items
 * @returns {number} total minutes (0 if none found)
 */
export function parsePdfText(items) {
  // Group text items by rounded Y coordinate to reconstruct rows
  const rowMap = new Map();
  for (const item of items) {
    if (!item.str) continue;
    const y = Math.round(item.transform[5]);
    if (!rowMap.has(y)) rowMap.set(y, []);
    rowMap.get(y).push(item.str);
  }

  // Sort rows top-to-bottom (PDF Y=0 is at the bottom, so higher Y = higher
  // on the page; sorting descending gives top-to-bottom reading order).
  const rows = [...rowMap.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, cells]) => cells);

  let totalMinutes = 0;
  for (let i = 0; i < rows.length; i++) {
    const rowText = rows[i].join(' ').toLowerCase();
    if (rowText.includes('qual') || rowText.includes('qualification')) {
      let dur = rowDurationMinutes(rows[i]);

      // If no times were found in the qual row itself, the PDF may place the
      // activity label and time values on slightly different baselines.  Try
      // merging with neighbouring rows to find the associated times.
      // Search order: i+1, i-1, i+2, i-2 (closest rows first in both
      // directions before widening the search).
      if (dur === null) {
        for (let offset = 1; dur === null && offset <= 2; offset++) {
          const next = rows[i + offset];
          const prev = rows[i - offset];
          if (next) dur = rowDurationMinutes([...rows[i], ...next]);
          if (dur === null && prev) dur = rowDurationMinutes([...rows[i], ...prev]);
        }
      }

      if (dur !== null) totalMinutes += dur;
    }
  }
  return totalMinutes;
}

/** CDN base for pdfjs-dist (exact version pinned; dynamic import() does not
 *  support Subresource Integrity, so pinning to a specific semver patch is
 *  the strongest integrity guarantee available without a build step). */
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/build';

/**
 * Fetch PDF bytes for the given URL.
 * @param {string} url
 * @returns {Promise<Uint8Array>}
 */
async function fetchPdfBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

/**
 * Load a PDF from the given URL, extract all text content with PDF.js, and
 * return the total qual-match minutes detected (null if nothing found).
 * @param {string} pdfUrl
 * @returns {Promise<number|null>}
 */
async function parsePdfAgenda(pdfUrl) {
  try {
    const pdfjsLib = await import(`${PDFJS_CDN}/pdf.min.mjs`);
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;

    const pdfBytes = await fetchPdfBytes(pdfUrl);
    const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;

    const allItems = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      allItems.push(...content.items);
    }

    const minutes = parsePdfText(allItems);
    return minutes > 0 ? minutes : null;
  } catch {
    return null;
  }
}

/**
 * Build the direct FIRST Inspires agenda PDF URL for a given event key.
 * Pattern: https://info.firstinspires.org/hubfs/web/event/frc/{year}/{year}_{CODE}_Agenda.pdf
 * Example: "2026nysu" → ".../2026/2026_NYSU_Agenda.pdf"
 * @param {string} eventKey  Must be at least 5 characters (4-digit year + event code).
 * @returns {string}
 */
export function firstInspiresPdfUrl(eventKey) {
  if (!eventKey || eventKey.length < 5) {
    throw new Error(`Invalid event key: "${eventKey}"`);
  }
  const year = eventKey.slice(0, 4);
  const code = eventKey.slice(4).toUpperCase();
  return `https://info.firstinspires.org/hubfs/web/event/frc/${year}/${year}_${code}_Agenda.pdf`;
}

/**
 * Load the event agenda from the direct FIRST Inspires PDF URL constructed
 * from the event key.
 *
 * Returns { qualMinutes, source, agendaUrl } where:
 *   qualMinutes – detected qual-match duration in minutes (null if not found)
 *   source      – human-readable description of what was found
 *   agendaUrl   – the URL of the agenda PDF
 *
 * When the PDF is found it is fetched and parsed with PDF.js to auto-detect
 * the qual time block.
 *
 * @param {string} eventKey
 * @returns {Promise<{qualMinutes:number|null, source:string, agendaUrl:string|null}>}
 */
export async function loadAgendaInfo(eventKey) {
  let agendaUrl;
  try {
    agendaUrl = firstInspiresPdfUrl(eventKey);
  } catch (err) {
    return { qualMinutes: null, source: err.message, agendaUrl: null };
  }
  const minutes = await parsePdfAgenda(agendaUrl);
  return {
    qualMinutes: minutes,
    source: minutes
      ? 'Parsed from PDF agenda'
      : 'Agenda is a PDF — please enter qual time manually',
    agendaUrl,
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
