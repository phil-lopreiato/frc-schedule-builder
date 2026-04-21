/**
 * Shared PDF agenda parsing logic.
 * Works in both browser (via CDN pdfjs) and Node.js (via pdfjs-dist npm package).
 * The caller is responsible for loading pdfjsLib and passing it to extractPDFText.
 */

export function parseTime12(s) {
  s = s.trim().toUpperCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]), ap = m[3];
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

/**
 * Normalise time tokens that PDF.js 4.x fragments with spurious spaces,
 * e.g. "8:5 0 AM" → "8:50AM", "1 1 : 3 0 A M" → "11:30AM".
 *
 * Uses [ \t] instead of \s so the regex never crosses a newline boundary
 * (which would corrupt day-of-week labels like "Tuesday, April 7\n8:00AM").
 *
 * Also repairs two district-specific PDF artefacts:
 *   - "fi" ligature split ("Quali fi cation" in some Wisconsin/other PDFs)
 *   - Truncated AM/PM where PDF.js puts the trailing "M" on the next text item
 *     (e.g. "12:30P" → "12:30PM", seen in some California district PDFs)
 */
export function normalizePDFText(text) {
  // Fix "fi" ligature split variants
  text = text.replace(/Qualif\s+ication/gi, 'Qualification');
  text = text.replace(/Quali\s+fi\s*cation/gi, 'Qualification');
  // Fix truncated AM/PM: "12:30P " → "12:30PM" when "M" landed on a different text item
  text = text.replace(/(\d{1,2}:\d{2})([AaPp])(?![Mm])/g, '$1$2M');
  // Collapse spaces within fragmented time tokens (PDF.js 4.x character spacing)
  return text.replace(
    /\d[ \t]?\d?[ \t]*:[ \t]*\d[ \t]*\d[ \t]*[AaPp][ \t]*[Mm]/g,
    m => m.replace(/\s+/g, '')
  );
}

/**
 * Extract text from a PDF buffer using the provided pdfjsLib instance.
 * Groups text items by Y coordinate to reconstruct visual lines, then normalises.
 *
 * @param {object} pdfjsLib - pdfjs library instance (browser CDN or npm pdfjs-dist)
 * @param {ArrayBuffer|Uint8Array} buf - raw PDF data
 * @returns {Promise<string>} normalised full text, one visual line per \n
 */
export async function extractPDFText(pdfjsLib, buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let allText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const byY = {};
    for (const item of tc.items) {
      const y = Math.round(item.transform[5]);
      if (!byY[y]) byY[y] = [];
      byY[y].push({ x: item.transform[4], str: item.str });
    }
    const sortedYs = Object.keys(byY).map(Number).sort((a, b) => b - a);
    for (const y of sortedYs) {
      const items = byY[y].sort((a, b) => a.x - b.x);
      allText += items.map(it => it.str).join(' ').trim() + '\n';
    }
  }
  return normalizePDFText(allText);
}

const CMP_DIVISION_KEY_TO_NAME = {
  arc: 'Archimedes',
  cur: 'Curie',
  dal: 'Daly',
  gal: 'Galileo',
  hop: 'Hopper',
  joh: 'Johnson',
  mil: 'Milstein',
  new: 'Newton',
};

const CMP_DIVISION_NAMES = Object.values(CMP_DIVISION_KEY_TO_NAME);
const CMP_DIVISION_NAME_LOOKUPS = CMP_DIVISION_NAMES.map(name => ({
  name,
  token: name.toLowerCase(),
}));

function normalizeDivisionName(name) {
  return (name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function inferCmpDivisionName({ eventName = '', eventKey = '' } = {}) {
  const lowerName = eventName.toLowerCase();
  for (const division of CMP_DIVISION_NAME_LOOKUPS) {
    if (lowerName.includes(division.token)) return division.name;
  }
  const suffix = (eventKey || '').slice(4).toLowerCase();
  return CMP_DIVISION_KEY_TO_NAME[suffix] || '';
}

function parseCmpDivisionQualBlocks(text, { eventName = '', eventKey = '' } = {}) {
  const divisionName = inferCmpDivisionName({ eventName, eventKey });
  if (!divisionName) return [];

  const blocks = [];
  const lines = text.replace(/\r/g, '').split('\n');
  const dayRe = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b\s*[,]?\s+(\w+\s+\d{1,2}|\d+\/\d+\/\d+)/i;
  const qualRe = /(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*[-\u2013\u2014]\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])\s+Qualification\s+Matches/i;
  const divisionBreakRe = /(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*[-\u2013\u2014]\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])\s+Division\s+Break\s*[-\u2013\u2014]\s*([A-Za-z]+)/i;

  let currentDay = '';
  const qualsByDay = [];
  const breaksByDay = new Map();

  for (const line of lines) {
    const dayMatch = dayRe.exec(line);
    if (dayMatch) currentDay = dayMatch[1].slice(0, 3) + ' ' + dayMatch[2];

    const qualMatch = qualRe.exec(line);
    if (qualMatch) {
      const start = parseTime12(qualMatch[1]);
      const end = parseTime12(qualMatch[2]);
      if (start !== null && end !== null && end > start) {
        qualsByDay.push({
          day: currentDay || `Block ${qualsByDay.length + 1}`,
          start,
          end,
          startStr: qualMatch[1].trim(),
          endStr: qualMatch[2].trim(),
        });
      }
      continue;
    }

    const breakMatch = divisionBreakRe.exec(line);
    if (breakMatch) {
      const breakDivision = normalizeDivisionName(breakMatch[3]);
      if (breakDivision !== normalizeDivisionName(divisionName)) continue;
      const start = parseTime12(breakMatch[1]);
      const end = parseTime12(breakMatch[2]);
      if (start === null || end === null || end <= start) continue;
      const key = currentDay || '__unknown__';
      if (!breaksByDay.has(key)) breaksByDay.set(key, []);
      breaksByDay.get(key).push({
        start,
        end,
        startStr: breakMatch[1].trim(),
        endStr: breakMatch[2].trim(),
      });
    }
  }

  for (const qual of qualsByDay) {
    const breaks = (breaksByDay.get(qual.day) || [])
      .sort((a, b) => a.start - b.start);

    let segmentStart = qual.start;
    let segmentStartStr = qual.startStr;

    for (const br of breaks) {
      const breakStart = Math.max(br.start, qual.start);
      const breakEnd = Math.min(br.end, qual.end);
      if (breakEnd <= breakStart) continue;

      if (breakStart > segmentStart) {
        blocks.push({
          start: segmentStart,
          end: breakStart,
          duration: breakStart - segmentStart,
          startStr: segmentStartStr,
          endStr: br.startStr,
          day: qual.day,
        });
      }

      segmentStart = breakEnd;
      segmentStartStr = br.endStr;
    }

    if (segmentStart < qual.end) {
      blocks.push({
        start: segmentStart,
        end: qual.end,
        duration: qual.end - segmentStart,
        startStr: segmentStartStr,
        endStr: qual.endStr,
        day: qual.day,
      });
    }
  }

  return blocks;
}

/**
 * Parse qual match blocks from normalised agenda text.
 * Returns up to N blocks with start/end times and day label.
 *
 * Handles several FIRST district agenda format variants:
 *   - Standard:    "HH:MM AM/PM – HH:MM AM/PM  Qualification Matches"
 *   - Peachtree:   same but with asterisk note marker "... * Qualification Matches"
 *   - Chesapeake:  tilde on approx end time "HH:MM AM/PM - ~HH:MM AM/PM  Qualification Matches"
 *   - Ontario:     two-column no-separator "HH:MM am/pm  HH:MM am/pm  Qualification Matches"
 *   - N. Carolina: start-time-only "HH:MM AM/PM  Qualification Matches Begin/Continue"
 *   - Wisconsin:   "Qualifi cation Matches" (fi ligature split — fixed in normalizePDFText)
 *
 * @param {string} text       - output of extractPDFText / normalizePDFText
 * @param {object} [opts]
 * @param {string} [opts.districtKey] - lowercase TBA district abbreviation (e.g. "nc", "ont")
 *                                      used for diagnostics; parsing is format-detected automatically
 * @param {number} [opts.eventType]   - TBA event_type (CMP divisions are type 3)
 * @param {string} [opts.eventName]   - event name, used for CMP division inference
 * @param {string} [opts.eventKey]    - event key, fallback for CMP division inference
 * @returns {Array<{start,end,duration,startStr,endStr,day}>}
 */
export function parseQualBlocks(text, { districtKey = '', eventType = null, eventName = '', eventKey = '' } = {}) {
  if (eventType === 3) {
    const cmpBlocks = parseCmpDivisionQualBlocks(text, { eventName, eventKey });
    if (cmpBlocks.length > 0) return cmpBlocks;
  }

  const blocks = [];
  const lines = text.replace(/\r/g, '').split('\n');

  // "Friday, March 20" or "Saturday , March 21" (PDF.js sometimes adds space before comma)
  // Also handles numeric dates like "Friday, 4/10/26" (Colorado district)
  const dayRe = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b\s*[,]?\s+(\w+\s+\d{1,2}|\d+\/\d+\/\d+)/i;

  // Standard / Peachtree / Chesapeake:
  //   optional single-char note marker (e.g. footnote "M", "*") on either side of the dash
  //   optional ~ on end time (Chesapeake approx times)
  const qualRe = /(\d{1,2}:\d{2}\s*[AaPp][Mm])(?:\s*[A-Za-z*†~]{1,2})?\s*[-\u2013\u2014]\s*~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])(?:\s*[A-Za-z0-9*†~]{1,2})?\s+Qualification\s+Match/i;

  // Ontario district: two-column schedule with no dash separator between start/end times.
  //   "11:30am   1:30pm   Qualification Matches"
  //   "2:30pm   7:00pm *  Qualification Matches"
  // Anchored at line start so it won't match dash-separated lines.
  const qualNoSepRe = /^(\d{1,2}:\d{2}\s*[AaPp][Mm])[ \t]+(\d{1,2}:\d{2}\s*[AaPp][Mm])[ \t*]+Qualification\s+Match/i;

  // North Carolina district: single start time with "Qualification Matches Begin|Continue"
  //   "10:50AM   Qualification Matches Begin"
  //   "2:00PM    Qualification Matches Continue ; Exhibits Close"
  const qualBeginRe = /^~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])[ \t]+Qualification\s+Match(?:es?)?[ \t]+(?:Begin|Continue)/i;
  const qualEndRe = /^~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])[ \t]+Qualification\s+Match(?:es?)?[ \t]+End/i;
  const lunchRe = /^~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*[-\u2013\u2014]\s*~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])(?:\s*[A-Za-z0-9*†~]{1,2})?\s+Lunch\b/i;

  // Leading time on a line — used to close an open "Begin" block
  const leadTimeRe = /^~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])/;

  let currentDay = '';
  let blockNum = 0;
  let openBeginBlock = null; // tracks NC-style "Begin/Continue" open block

  const hasBlock = start => blocks.some(b => Math.abs(b.start - start) < 20);

  function closeOpenBlock(endStr, endTime) {
    if (!openBeginBlock) return;
    if (endTime !== null && endTime > openBeginBlock.start && !hasBlock(openBeginBlock.start)) {
      blockNum++;
      blocks.push({
        start: openBeginBlock.start,
        end: endTime,
        duration: endTime - openBeginBlock.start,
        startStr: openBeginBlock.startStr,
        endStr,
        day: openBeginBlock.day,
      });
    }
    openBeginBlock = null;
  }

  for (const line of lines) {
    const dayMatch = dayRe.exec(line);
    if (dayMatch) {
      currentDay = dayMatch[1].substring(0, 3) + ' ' + dayMatch[2];
    }

    // Try standard (with separator) and Ontario (no separator) patterns
    const qualMatch = qualRe.exec(line) || qualNoSepRe.exec(line);
    if (qualMatch) {
      const start = parseTime12(qualMatch[1]);
      const end   = parseTime12(qualMatch[2]);
      if (start !== null && end !== null && end > start) {
        if (openBeginBlock) {
          if (Math.abs(openBeginBlock.start - start) >= 20) {
            // Different session — close the open begin block at this start time
            closeOpenBlock(qualMatch[1].trim(), start);
          } else {
            // Same session found via full time range — discard begin tracking
            openBeginBlock = null;
          }
        }
        blockNum++;
        blocks.push({
          start, end,
          duration: end - start,
          startStr: qualMatch[1].trim(),
          endStr:   qualMatch[2].trim(),
          day: currentDay || ('Block ' + blockNum),
        });
      }
      continue;
    }

    // NC-style: single start time with Begin/Continue keyword
    const beginMatch = qualBeginRe.exec(line.trim());
    if (beginMatch) {
      const t = parseTime12(beginMatch[1]);
      if (t !== null) {
        if (openBeginBlock && t > openBeginBlock.start) {
          // "Continue" closes the previous open block at the Continue start time
          closeOpenBlock(beginMatch[1].trim(), t);
        }
        openBeginBlock = { start: t, startStr: beginMatch[1].trim(), day: currentDay || '' };
      }
      continue;
    }

    const endMatch = qualEndRe.exec(line.trim());
    if (endMatch) {
      const t = parseTime12(endMatch[1]);
      if (t !== null) closeOpenBlock(endMatch[1].trim(), t);
      continue;
    }

    const lunchMatch = openBeginBlock ? lunchRe.exec(line.trim()) : null;
    if (lunchMatch && openBeginBlock) {
      const lunchStart = parseTime12(lunchMatch[1]);
      const lunchEnd = parseTime12(lunchMatch[2]);
      if (lunchStart !== null && lunchEnd !== null && lunchEnd > lunchStart) {
        if (lunchStart > openBeginBlock.start) {
          closeOpenBlock(lunchMatch[1].trim(), lunchStart);
        }
        openBeginBlock = {
          start: Math.max(openBeginBlock?.start ?? lunchEnd, lunchEnd),
          startStr: lunchMatch[2].trim(),
          day: currentDay || openBeginBlock?.day || '',
        };
      }
      continue;
    }

    // Close an open Begin block when the next time entry appears (≥ 30 min later, so we
    // don't accidentally close on a brief intermediate time like a 5-min field break)
    if (openBeginBlock) {
      const m = leadTimeRe.exec(line.trim());
      if (m) {
        const t = parseTime12(m[1]);
        if (t && t > openBeginBlock.start && (t - openBeginBlock.start) >= 30) {
          closeOpenBlock(m[1].trim(), t);
        }
      }
    }
  }

  // Fallback: join all lines and retry (handles rare PDF.js line-break concatenation)
  if (blocks.length === 0) {
    const fullText = text.replace(/\n/g, ' ');
    const reG = /(\d{1,2}:\d{2}\s*[AaPp][Mm])(?:\s*[A-Za-z*†~]{1,2})?\s*[-\u2013\u2014]\s*~?\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])(?:\s*[A-Za-z0-9*†~]{1,2})?\s+Qualification\s+Match/gi;
    let m;
    while ((m = reG.exec(fullText)) !== null) {
      const start = parseTime12(m[1]);
      const end   = parseTime12(m[2]);
      blockNum++;
      if (start !== null && end !== null && end > start) {
        blocks.push({
          start, end,
          duration: end - start,
          startStr: m[1].trim(),
          endStr:   m[2].trim(),
          day: 'Block ' + blockNum,
        });
      }
    }
  }

  // Merge consecutive blocks separated by a short field break (≤ 30 min).
  // Some districts (e.g. Wisconsin) split one afternoon session across two schedule rows
  // with a brief break; for scheduling purposes these count as a single block.
  for (let i = blocks.length - 1; i > 0; i--) {
    const gap = blocks[i].start - blocks[i - 1].end;
    if (gap >= 0 && gap <= 30) {
      blocks[i - 1] = {
        ...blocks[i - 1],
        end:      blocks[i].end,
        endStr:   blocks[i].endStr,
        duration: blocks[i].end - blocks[i - 1].start,
      };
      blocks.splice(i, 1);
    }
  }

  return blocks;
}
