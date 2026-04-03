export type IndicatorCandle = {
  time: number;
  close: number;
};

export type IndicatorPoint = {
  time: number;
  value: number;
};

export interface IndicatorDefinition<TConfig, TValue extends IndicatorPoint = IndicatorPoint> {
  id: string;
  label: string;
  compute: (candles: IndicatorCandle[], config: TConfig) => TValue[];
}

export interface SmaConfig {
  period: number;
}

export const DEFAULT_SMA_PERIOD = 20;

export function sanitizeIndicatorPeriod(
  period: number,
  fallback = DEFAULT_SMA_PERIOD
): number {
  if (!Number.isFinite(period)) {
    return fallback;
  }

  return Math.max(2, Math.floor(period));
}

function computeSmaPoint(
  candles: IndicatorCandle[],
  index: number,
  period: number
): IndicatorPoint | null {
  if (index < period - 1) {
    return null;
  }

  let sum = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    sum += candles[cursor]?.close ?? 0;
  }

  return {
    time: candles[index].time,
    value: sum / period,
  };
}

export const SMA_INDICATOR: IndicatorDefinition<SmaConfig> = {
  id: "sma",
  label: "Simple Moving Average",
  compute: (candles, config) => {
    const period = sanitizeIndicatorPeriod(config.period);
    const result: IndicatorPoint[] = [];

    for (let index = period - 1; index < candles.length; index += 1) {
      const point = computeSmaPoint(candles, index, period);
      if (point) {
        result.push(point);
      }
    }

    return result;
  },
};

export function computeSma(candles: IndicatorCandle[], config: SmaConfig): IndicatorPoint[] {
  return SMA_INDICATOR.compute(candles, config);
}

function indicatorCandlesEqual(left: IndicatorCandle, right: IndicatorCandle): boolean {
  return left.time === right.time && left.close === right.close;
}

export function getIncrementalSmaPoint(
  previous: IndicatorCandle[],
  next: IndicatorCandle[],
  period: number
): IndicatorPoint | null {
  const normalizedPeriod = sanitizeIndicatorPeriod(period);

  if (previous.length === 0 || next.length === 0 || next.length < normalizedPeriod) {
    return null;
  }

  if (next.length === previous.length) {
    if (previous[0]?.time !== next[0]?.time) {
      return null;
    }

    for (let index = 0; index < next.length - 1; index += 1) {
      if (!indicatorCandlesEqual(previous[index], next[index])) {
        return null;
      }
    }

    return indicatorCandlesEqual(previous[previous.length - 1], next[next.length - 1])
      ? null
      : computeSmaPoint(next, next.length - 1, normalizedPeriod);
  }

  if (next.length === previous.length + 1) {
    for (let index = 0; index < previous.length; index += 1) {
      if (!indicatorCandlesEqual(previous[index], next[index])) {
        return null;
      }
    }

    return computeSmaPoint(next, next.length - 1, normalizedPeriod);
  }

  return null;
}
