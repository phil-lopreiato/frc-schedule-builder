export function cycleTimeForMatch(matchIndex, cycleTimes, totalMatches, mpt) {
  if (totalMatches <= 0) return cycleTimes[0] || 8;
  return cycleTimes[Math.min(Math.floor(matchIndex * mpt / totalMatches), mpt - 1)] || 8;
}

export function totalMatchTime(totalMatches, cycleTimes, mpt) {
  let total = 0;
  for (let m = 0; m < totalMatches; m++) {
    total += cycleTimeForMatch(m, cycleTimes, totalMatches, mpt);
  }
  return total;
}

export function buildBlockPlans(totalMatches, cycleTimes, mpt, blocks) {
  const matchDurations = Array.from(
    { length: totalMatches },
    (_, matchIndex) => cycleTimeForMatch(matchIndex, cycleTimes, totalMatches, mpt)
  );
  const remainingMatchTime = Array(totalMatches + 1).fill(0);
  for (let i = totalMatches - 1; i >= 0; i--) {
    remainingMatchTime[i] = remainingMatchTime[i + 1] + matchDurations[i];
  }

  const remainingBlockTime = Array(blocks.length + 1).fill(0);
  for (let i = blocks.length - 1; i >= 0; i--) {
    remainingBlockTime[i] = remainingBlockTime[i + 1] + blocks[i].duration;
  }

  // Extra matches beyond the allotted block time should overflow into the middle
  // block, not the first block. Only allow forced overflow from the middle block
  // index onwards so that earlier blocks never run past their scheduled duration.
  const middleBlockIndex = Math.floor(blocks.length / 2);

  let matchStart = 0;
  const blockPlans = blocks.map((block, blockIndex) => {
    const startMatch = matchStart;
    let usedTime = 0;

    while (matchStart < totalMatches) {
      const matchTime = matchDurations[matchStart];
      const futureCapacity = remainingBlockTime[blockIndex + 1];
      const remainingAfterCurrent = remainingMatchTime[matchStart];
      const fitsInWindow = usedTime + matchTime <= block.duration;
      const mustUseCurrentWindow = blockIndex >= middleBlockIndex && remainingAfterCurrent > futureCapacity;

      if (!fitsInWindow && !mustUseCurrentWindow) break;

      usedTime += matchTime;
      matchStart++;
    }

    return {
      count: matchStart - startMatch,
      matchStart: startMatch,
      usedTime,
      actualEnd: block.start + usedTime,
      overage: usedTime - block.duration,
      fillPct: block.duration > 0 ? Math.min(usedTime / block.duration * 100, 100) : 0,
    };
  });

  return {
    availableMin: remainingBlockTime[0],
    actualTimeNeeded: remainingMatchTime[0],
    blockPlans,
  };
}
