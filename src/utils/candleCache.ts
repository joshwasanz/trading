import type { Candle, ProviderMode, Timeframe } from "../types/marketData";
import {
  sanitizeLatestWindowFetchMeta,
  type LatestWindowFetchMeta,
} from "./historyFreshness";

export type CandleCacheData = Record<string, Partial<Record<Timeframe, Candle[]>>>;
export type CandleCacheLatestFetches = Record<
  string,
  Partial<Record<Timeframe, LatestWindowFetchMeta>>
>;

type CandleCacheEnvelope = {
  version: number;
  data: CandleCacheData;
  latestFetches: CandleCacheLatestFetches;
};

const TIMEFRAMES: Timeframe[] = ["15s", "1m", "3m"];
const CACHE_VERSION = 1;

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

export function sanitizeLatestWindowFetches(value: unknown): CandleCacheLatestFetches {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const parsed = value as Record<string, unknown>;
  const sanitized: CandleCacheLatestFetches = {};

  for (const [symbol, maybeSeries] of Object.entries(parsed)) {
    if (!maybeSeries || typeof maybeSeries !== "object" || Array.isArray(maybeSeries)) {
      continue;
    }

    const series = maybeSeries as Record<string, unknown>;
    const nextSeries: Partial<Record<Timeframe, LatestWindowFetchMeta>> = {};

    for (const timeframe of TIMEFRAMES) {
      const meta = sanitizeLatestWindowFetchMeta(series[timeframe]);
      if (meta) {
        nextSeries[timeframe] = meta;
      }
    }

    if (Object.keys(nextSeries).length > 0) {
      sanitized[symbol] = nextSeries;
    }
  }

  return sanitized;
}

export function getScopedMarketDataStorageKey(baseKey: string, providerMode: ProviderMode) {
  return `${baseKey}:${providerMode}`;
}

export function loadScopedCandleCache(
  storage: Storage,
  baseKey: string,
  legacyKeys: string[],
  providerMode: ProviderMode
): CandleCacheData {
  return loadScopedCandleCacheEnvelope(storage, baseKey, legacyKeys, providerMode).data;
}

export function loadScopedCandleCacheEnvelope(
  storage: Storage,
  baseKey: string,
  legacyKeys: string[],
  providerMode: ProviderMode
): CandleCacheEnvelope {
  clearLegacyMarketDataCaches(storage, legacyKeys);
  const cached = storage.getItem(getScopedMarketDataStorageKey(baseKey, providerMode));
  if (!cached) {
    return {
      version: CACHE_VERSION,
      data: {},
      latestFetches: {},
    };
  }

  const parsed = JSON.parse(cached) as
    | CandleCacheEnvelope
    | CandleCacheData;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed) {
    return {
      version: CACHE_VERSION,
      data: sanitizeCachedCandleData(parsed.data),
      latestFetches: sanitizeLatestWindowFetches(parsed.latestFetches),
    };
  }

  return {
    version: CACHE_VERSION,
    data: sanitizeCachedCandleData(parsed),
    latestFetches: {},
  };
}

export function persistScopedCandleCache(
  storage: Storage,
  baseKey: string,
  legacyKeys: string[],
  providerMode: ProviderMode,
  data: CandleCacheData
) {
  persistScopedCandleCacheEnvelope(storage, baseKey, legacyKeys, providerMode, {
    data,
    latestFetches: {},
  });
}

export function persistScopedCandleCacheEnvelope(
  storage: Storage,
  baseKey: string,
  legacyKeys: string[],
  providerMode: ProviderMode,
  envelope: {
    data: CandleCacheData;
    latestFetches: CandleCacheLatestFetches;
  }
) {
  clearLegacyMarketDataCaches(storage, legacyKeys);
  storage.setItem(
    getScopedMarketDataStorageKey(baseKey, providerMode),
    JSON.stringify({
      version: CACHE_VERSION,
      data: envelope.data,
      latestFetches: envelope.latestFetches,
    } satisfies CandleCacheEnvelope)
  );
}

export function clearLegacyMarketDataCaches(storage: Storage, keys: string[]) {
  for (const key of keys) {
    storage.removeItem(key);
  }
}
