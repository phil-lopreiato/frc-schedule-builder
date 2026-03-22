import assert from 'node:assert/strict';
import { buildBlockPlans } from './schedule-layout.mjs';

const blocks = [
  { start: 9 * 60, duration: 60 },
  { start: 10 * 60 + 30, duration: 60 },
];

{
  const totalMatches = 6;
  const mpt = 3;
  const cycleTimes = [8, 20, 8];
  const layout = buildBlockPlans(totalMatches, cycleTimes, mpt, blocks);

  assert.equal(layout.actualTimeNeeded, 72);
  assert.equal(layout.availableMin, 120);
  assert.deepEqual(
    layout.blockPlans.map(plan => plan.count),
    [4, 2],
    'slow middle round should spill later matches into the next block'
  );
  assert.deepEqual(
    layout.blockPlans.map(plan => plan.usedTime),
    [56, 16],
    'block usage should reflect the actual per-match timing profile'
  );
  assert.deepEqual(
    layout.blockPlans.map(plan => plan.actualEnd),
    [9 * 60 + 56, 10 * 60 + 30 + 16],
    'block boundaries should be recomputed from packed match durations'
  );
}

{
  const totalMatches = 6;
  const mpt = 3;
  const cycleTimes = [8, 8, 8];
  const layout = buildBlockPlans(totalMatches, cycleTimes, mpt, blocks);

  assert.deepEqual(
    layout.blockPlans.map(plan => plan.count),
    [6, 0],
    'faster rounds should reflow matches back into earlier windows when they fit'
  );
  assert.deepEqual(
    layout.blockPlans.map(plan => plan.actualEnd),
    [9 * 60 + 48, 10 * 60 + 30],
    'actual block boundaries should shrink when the same schedule fits sooner'
  );
}

console.log('✓ schedule layout reflow tests passed');
