/**
 * Test script: fetch all 2026 FRC regional/district/CMP division events from TBA,
 * attempt to parse each agenda PDF, and assert expected qual match block counts.
 *
 * Usage:
 *   npm install
 *   node test-agenda.mjs
 *
 * Requires Node 18+ (native fetch). Uses pdfjs-dist@4.0.379 to match the
 * version loaded from CDN in the browser app.
 */

import { extractPDFText, parseQualBlocks } from './agenda-parser.mjs';
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';

const TBA_KEY = 'OgkQlossATyHZij8FEAKl0opKiW63fDDSf7Fcwnr9jcJON5XwiGHgmCVZvjFb1Lv';
const EXPECTED_STANDARD_BLOCKS = 3;
const EXPECTED_CMP_DIVISION_BLOCKS = 4;
const EXPECTED_DCMP_BLOCK_OPTIONS = new Set([3, 4]);
const CMP_PUBLIC_SCHEDULE_URL = 'https://www.firstinspires.org/hubfs/web/event/2026/cmp/frc/public-schedule.pdf';
const CONCURRENCY = 6;

async function fetchEvents() {
  const r = await fetch('https://www.thebluealliance.com/api/v3/events/2026', {
    headers: { 'X-TBA-Auth-Key': TBA_KEY },
  });
  if (!r.ok) throw new Error(`TBA API error: ${r.status}`);
  const events = await r.json();
  // event_type 0 = Regional, 1 = District, 2 = District Championship,
  // 3 = Championship Division, 5 = District Championship Division
  return events
    .filter(e =>
      e.event_type === 0 ||
      e.event_type === 1 ||
      e.event_type === 2 ||
      e.event_type === 3 ||
      e.event_type === 4 ||
      e.event_type === 5
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function fetchAgendaPDF(event) {
  if (event.event_type === 3 || event.event_type === 4) {
    const r = await fetch(CMP_PUBLIC_SCHEDULE_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  const key = event.key;
  const year = key.slice(0, 4);
  const eventPart = key.slice(4).toUpperCase();
  const url = `https://info.firstinspires.org/hubfs/web/event/frc/${year}/${year}_${eventPart}_Agenda.pdf`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function testEvent(event) {
  const { key } = event;
  const districtKey = event.district?.abbreviation?.toLowerCase() ?? '';
  const isCmpDivision = event.event_type === 3;
  const isDcmpOrDivision = event.event_type === 2 || event.event_type === 5;
  const expectedBlocks = isCmpDivision ? EXPECTED_CMP_DIVISION_BLOCKS : EXPECTED_STANDARD_BLOCKS;

  let buf;
  try {
    buf = await fetchAgendaPDF(event);
  } catch (e) {
    return { key, status: 'error', reason: `fetch failed: ${e.message}` };
  }
  if (!buf) return { key, status: 'skip' };

  let blocks;
  try {
    const text = await extractPDFText(pdfjsLib, buf);
    blocks = parseQualBlocks(text, {
      districtKey,
      eventType: event.event_type,
      eventName: event.name,
      eventKey: event.key,
    });
  } catch (e) {
    return { key, status: 'error', reason: `parse failed: ${e.message}` };
  }

  if (isDcmpOrDivision && EXPECTED_DCMP_BLOCK_OPTIONS.has(blocks.length)) {
    return { key, status: 'pass', blocks };
  }
  if (blocks.length === expectedBlocks) {
    return { key, status: 'pass', blocks };
  }
  const expectedDescription = isDcmpOrDivision
    ? '3 or 4'
    : String(expectedBlocks);
  return {
    key, status: 'fail',
    reason: `expected ${expectedDescription} blocks, got ${blocks.length}${districtKey ? ` (district: ${districtKey})` : ''}`,
    blocks,
  };
}

// Run fn over items with at most `limit` concurrent inflight calls
async function pooled(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log('Fetching 2026 event list from TBA…');
const events = await fetchEvents();
console.log(`Found ${events.length} regional/district events. Testing PDF parsing…\n`);

let done = 0;
const results = await pooled(events, async event => {
  const result = await testEvent(event);
  done++;
  const icon = result.status === 'pass' ? '✓' : result.status === 'skip' ? '·' : '✗';
  const detail = result.status === 'pass'
    ? result.blocks.map(b => `${b.day} ${b.startStr}–${b.endStr}`).join('  |  ')
    : result.status === 'skip' ? 'no PDF'
    : result.reason;
  process.stdout.write(`[${String(done).padStart(3)}/${events.length}] ${icon} ${result.key.padEnd(14)} ${detail}\n`);
  return result;
}, CONCURRENCY);

// ── summary ───────────────────────────────────────────────────────────────────

const passed  = results.filter(r => r.status === 'pass');
const failed  = results.filter(r => r.status === 'fail');
const errored = results.filter(r => r.status === 'error');
const skipped = results.filter(r => r.status === 'skip');

console.log(`
── Results ────────────────────────────────────────────
  ✓ passed : ${passed.length}
  · skipped: ${skipped.length}  (no PDF found)
  ✗ failed : ${failed.length}  (wrong block count)
  ✗ errors : ${errored.length}  (fetch/parse exception)`);

if (failed.length > 0) {
  console.log('\nFailed events:');
  for (const r of failed) {
    console.log(`  ${r.key}: ${r.reason}`);
    for (const b of r.blocks) {
      console.log(`    ${b.day}: ${b.startStr} – ${b.endStr} (${b.duration} min)`);
    }
  }
}

if (errored.length > 0) {
  console.log('\nErrored events:');
  for (const r of errored) console.log(`  ${r.key}: ${r.reason}`);
}

process.exit(failed.length > 0 || errored.length > 0 ? 1 : 0);
