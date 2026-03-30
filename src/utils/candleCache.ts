import type { Candle, Timeframe } from "../types/marketData";

export type CandleCacheData = Record<string, Partial<Record<Timeframe, Candle[]>>>;

const TIMEFRAMES: Timeframe[] = ["15s", "1m", "3m"];

function timeframeSeconds(timeframe: Timeframe): number {
  switch (timeframe) {
    case "15s":
      return 15;
    case "1m":
      return 60;
    case "3m":
      return 180;
    default:
      return 60;
  }
}

function normalizeStoredCandle(
  symbol: string,
  timeframe: Timeframe,
  value: unknown
): Candle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const maybe = value as Partial<Candle>;
  const time =
    typeof maybe.time === "number" && Number.isFinite(maybe.time) ? maybe.time : null;
  const open =
    typeof maybe.open === "number" && Number.isFinite(maybe.open) ? maybe.open : null;
  const high =
    typeof maybe.high === "number" && Number.isFinite(maybe.high) ? maybe.high : null;
  const low =
    typeof maybe.low === "number" && Number.isFinite(maybe.low) ? maybe.low : null;
  const close =
    typeof maybe.close === "number" && Number.isFinite(maybe.close) ? maybe.close : null;

  if (time === null || open === null || high === null || low === null || close === null) {
    return null;
  }

  const step = timeframeSeconds(timeframe);
  if (time % step !== 0) {
    return null;
  }

  return {
    symbol,
    time,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
  };
}

export function sanitizeCandleSeries(
  symbol: string,
  timeframe: Timeframe,
  value: unknown
): Candle[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byTime = new Map<number, Candle>();

  for (const item of value) {
    const candle = normalizeStoredCandle(symbol, timeframe, item);
    if (!candle) {
      continue;
    }

    byTime.set(candle.time, candle);
  }

  return Array.from(byTime.values()).sort((left, right) => left.time - right.time);
}

export function sanitizeCachedCandleData(value: unknown): CandleCacheData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const parsed = value as Record<string, unknown>;
  const sanitized: CandleCacheData = {};

  for (const [symbol, maybeSeries] of Object.entries(parsed)) {
    if (!maybeSeries || typeof maybeSeries !== "object" || Array.isArray(maybeSeries)) {
      continue;
    }

    const series = maybeSeries as Record<string, unknown>;
    const nextSeries: Partial<Record<Timeframe, Candle[]>> = {};

    for (const timeframe of TIMEFRAMES) {
      nextSeries[timeframe] = sanitizeCandleSeries(symbol, timeframe, series[timeframe]);
    }

    sanitized[symbol] = nextSeries;
  }

  return sanitized;
}

export function clearLegacyMarketDataCaches(storage: Storage, keys: string[]) {
  for (const key of keys) {
    storage.removeItem(key);
  }
}
