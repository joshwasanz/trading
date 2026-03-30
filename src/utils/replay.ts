type CandleLike = {
  time: number;
};

export function findCandleIndexAtOrBefore<T extends CandleLike>(
  candles: T[],
  targetTime: number
): number {
  if (candles.length === 0) return 0;

  let left = 0;
  let right = candles.length - 1;
  let answer = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const time = candles[mid]?.time;

    if (typeof time !== "number") {
      right = mid - 1;
      continue;
    }

    if (time <= targetTime) {
      answer = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return answer;
}
