import { invoke } from "@tauri-apps/api/core";
import type { Candle, Timeframe } from "../types/marketData";

type FastTickListener = (candle: Candle) => void;

export type FastTickSubscription = {
  unsubscribe: () => void;
  updateSeed: (candle: Candle | null) => void;
};

type TimeframeListenerMap = Record<Timeframe, Map<number, FastTickListener>>;
type TimeframeSeedMap = Record<Timeframe, Map<number, Candle | null>>;

type BestSeedSelection = {
  timeframe: Timeframe;
  expanded: Candle[];
  target15s: Candle;
};

type SymbolSyntheticEngine = {
  symbol: string;
  listeners: TimeframeListenerMap;
  seeds: TimeframeSeedMap;
  intervalId: number | null;
  finalized15s: Candle[];
  current15s: Candle | null;
  price: number | null;
  anchorPrice: number | null;
  driftBias: number;
  impulse: number;
  impulseTicksRemaining: number;
  noiseState: number;
  tickCount: number;
};

const DEFAULT_FAST_TICK_INTERVAL_MS = 16;
const MAX_FINALIZED_15S_CANDLES = 240;
const MIN_RELATIVE_AMPLITUDE = 0.00004;
const FAST_TICK_DIAGNOSTICS =
  import.meta.env.DEV && import.meta.env.VITE_FAST_TICK_DIAGNOSTICS === "true";

const engines = new Map<string, SymbolSyntheticEngine>();
let nextListenerId = 1;

function relayFastTickDebugLog(scope: string, payload: Record<string, unknown>) {
  if (!FAST_TICK_DIAGNOSTICS) {
    return;
  }

  void invoke("frontend_debug_log", {
    scope,
    payload: JSON.stringify(payload),
  }).catch(() => undefined);
}

function parseFastTickInterval(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_FAST_TICK_INTERVAL_MS;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(4, Math.floor(parsed))
    : DEFAULT_FAST_TICK_INTERVAL_MS;
}

export const FAST_TICK_INTERVAL_MS = parseFastTickInterval(
  import.meta.env.VITE_FAST_TICK_INTERVAL_MS
);

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

function hashSymbol(symbol: string): number {
  let hash = 2166136261;

  for (let index = 0; index < symbol.length; index += 1) {
    hash ^= symbol.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0 || 1;
}

function createContextKey(symbol: string, timeframe: Timeframe): string {
  return `${normalizeSymbol(symbol)}::${timeframe}`;
}

function timeframeToSeconds(timeframe: Timeframe): number {
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

function alignCandleTime(time: number, timeframe: Timeframe): number {
  const size = timeframeToSeconds(timeframe);
  return time - (time % size);
}

function createEmptyListenerMap(): TimeframeListenerMap {
  return {
    "15s": new Map(),
    "1m": new Map(),
    "3m": new Map(),
  };
}

function createEmptySeedMap(): TimeframeSeedMap {
  return {
    "15s": new Map(),
    "1m": new Map(),
    "3m": new Map(),
  };
}

function cloneCandle(candle: Candle): Candle {
  return { ...candle };
}

function inferPricePrecision(price: number): number {
  if (price >= 10_000) {
    return 2;
  }

  if (price >= 100) {
    return 3;
  }

  if (price >= 1) {
    return 4;
  }

  return 5;
}

function roundPrice(price: number, reference: number): number {
  return Number(price.toFixed(inferPricePrecision(reference)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function minAbsoluteAmplitude(price: number): number {
  if (price >= 10_000) {
    return 0.8;
  }

  if (price >= 1_000) {
    return 0.18;
  }

  if (price >= 100) {
    return 0.045;
  }

  if (price >= 10) {
    return 0.012;
  }

  if (price >= 1) {
    return 0.00035;
  }

  return 0.00008;
}

function getSymbolVolatilityScale(symbol: string): number {
  switch (normalizeSymbol(symbol)) {
    case "ndx":
      return 1.45;
    case "spx":
      return 1.08;
    case "dji":
      return 1.18;
    case "usdjpy":
      return 0.94;
    case "eurusd":
      return 0.72;
    default:
      return 1;
  }
}

function get15sAmplitude(symbol: string, close: number): number {
  return Math.max(Math.abs(close) * MIN_RELATIVE_AMPLITUDE, minAbsoluteAmplitude(close)) *
    getSymbolVolatilityScale(symbol);
}

function normalizeSeedCandle(candle: Candle, timeframe: Timeframe): Candle {
  const alignedTime = alignCandleTime(candle.time, timeframe);
  const open = roundPrice(candle.open, candle.close);
  const close = roundPrice(candle.close, candle.close);
  const high = roundPrice(Math.max(candle.high, open, close), candle.close);
  const low = roundPrice(Math.min(candle.low, open, close), candle.close);

  return {
    ...candle,
    symbol: normalizeSymbol(candle.symbol),
    time: alignedTime,
    open,
    high,
    low,
    close,
  };
}

function interpolateAnchors(anchors: Array<{ index: number; value: number }>, segments: number): number[] {
  const sortedAnchors = [...anchors].sort((left, right) => left.index - right.index);
  const values = new Array<number>(segments + 1);

  for (let anchorIndex = 0; anchorIndex < sortedAnchors.length - 1; anchorIndex += 1) {
    const current = sortedAnchors[anchorIndex];
    const next = sortedAnchors[anchorIndex + 1];
    const span = Math.max(1, next.index - current.index);

    for (let offset = 0; offset <= span; offset += 1) {
      const ratio = offset / span;
      values[current.index + offset] = current.value + (next.value - current.value) * ratio;
    }
  }

  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== "number") {
      values[index] = values[index - 1] ?? sortedAnchors[sortedAnchors.length - 1]?.value ?? 0;
    }
  }

  return values;
}

function subdivideSeedTo15s(seed: Candle, timeframe: Timeframe): Candle[] {
  const normalized = normalizeSeedCandle(seed, timeframe);

  if (timeframe === "15s") {
    return [normalized];
  }

  const segmentCount = timeframe === "1m" ? 4 : 12;
  const segmentSeconds = 15;
  const bullish = normalized.close >= normalized.open;
  const firstExtremeIndex = Math.max(1, Math.floor(segmentCount * 0.28));
  const secondExtremeIndex = Math.max(firstExtremeIndex + 1, Math.floor(segmentCount * 0.75));
  const path = interpolateAnchors(
    bullish
      ? [
          { index: 0, value: normalized.open },
          { index: firstExtremeIndex, value: normalized.low },
          { index: secondExtremeIndex, value: normalized.high },
          { index: segmentCount, value: normalized.close },
        ]
      : [
          { index: 0, value: normalized.open },
          { index: firstExtremeIndex, value: normalized.high },
          { index: secondExtremeIndex, value: normalized.low },
          { index: segmentCount, value: normalized.close },
        ],
    segmentCount
  );

  return Array.from({ length: segmentCount }, (_, index) => {
    const segmentOpen = roundPrice(path[index] ?? normalized.open, normalized.close);
    const segmentClose = roundPrice(path[index + 1] ?? normalized.close, normalized.close);

    return {
      symbol: normalized.symbol,
      time: normalized.time + index * segmentSeconds,
      open: segmentOpen,
      high: roundPrice(Math.max(segmentOpen, segmentClose), normalized.close),
      low: roundPrice(Math.min(segmentOpen, segmentClose), normalized.close),
      close: segmentClose,
    } satisfies Candle;
  });
}

function trimFinalized15s(candles: Candle[]): Candle[] {
  if (candles.length <= MAX_FINALIZED_15S_CANDLES) {
    return candles;
  }

  return candles.slice(candles.length - MAX_FINALIZED_15S_CANDLES);
}

function mergeFinalized15s(
  existing: Candle[],
  replacements: Candle[],
  currentTime: number
): Candle[] {
  const merged = new Map<number, Candle>();

  for (const candle of existing) {
    if (candle.time < currentTime) {
      merged.set(candle.time, candle);
    }
  }

  for (const candle of replacements) {
    if (candle.time < currentTime) {
      merged.set(candle.time, candle);
    }
  }

  return trimFinalized15s(
    Array.from(merged.values()).sort((left, right) => left.time - right.time)
  );
}

function resetEngineDynamics(engine: SymbolSyntheticEngine): void {
  engine.price = engine.current15s?.close ?? engine.price ?? null;
  engine.anchorPrice = engine.current15s?.close ?? engine.anchorPrice ?? engine.price ?? null;
  engine.driftBias = 0;
  engine.impulse = 0;
  engine.impulseTicksRemaining = 0;
  engine.tickCount = 0;
}

function carryDynamicsAcrossRollover(engine: SymbolSyntheticEngine): void {
  engine.driftBias *= 0.82;
  engine.impulse = 0;
  engine.impulseTicksRemaining = 0;
  engine.tickCount = 0;
}

function nextNoiseUnit(engine: SymbolSyntheticEngine): number {
  engine.noiseState = (Math.imul(engine.noiseState, 1664525) + 1013904223) >>> 0;
  return engine.noiseState / 0xffffffff;
}

function nextSignedNoise(engine: SymbolSyntheticEngine): number {
  return nextNoiseUnit(engine) * 2 - 1;
}

function evolveEnginePrice(engine: SymbolSyntheticEngine): number {
  const baseline =
    engine.price ??
    engine.current15s?.close ??
    engine.anchorPrice ??
    1;
  const amplitude = get15sAmplitude(engine.symbol, baseline);

  if (engine.tickCount % 28 === 0) {
    engine.driftBias = clamp(
      engine.driftBias * 0.72 + nextSignedNoise(engine) * 0.55,
      -1.6,
      1.6
    );
  } else {
    engine.driftBias = clamp(
      engine.driftBias * 0.992 + nextSignedNoise(engine) * 0.018,
      -1.6,
      1.6
    );
  }

  if (engine.impulseTicksRemaining === 0 && nextNoiseUnit(engine) < 0.009) {
    engine.impulse =
      nextSignedNoise(engine) * amplitude * (0.9 + nextNoiseUnit(engine) * 1.8);
    engine.impulseTicksRemaining = 4 + Math.floor(nextNoiseUnit(engine) * 8);
  }

  const impulse =
    engine.impulseTicksRemaining > 0 ? engine.impulse : 0;
  if (engine.impulseTicksRemaining > 0) {
    engine.impulseTicksRemaining -= 1;
    engine.impulse *= 0.84;
  } else {
    engine.impulse = 0;
  }

  const anchor = engine.anchorPrice ?? baseline;
  const meanReversion = (anchor - baseline) * 0.014;
  const microNoise = nextSignedNoise(engine) * amplitude * 0.24;
  const secondaryNoise = nextSignedNoise(engine) * amplitude * 0.11;
  const drift = engine.driftBias * amplitude * 0.075;
  const momentum =
    Math.sign(engine.driftBias || nextSignedNoise(engine)) *
    nextNoiseUnit(engine) *
    amplitude *
    0.035;

  const nextPrice = roundPrice(
    Math.max(0.00001, baseline + meanReversion + microNoise + secondaryNoise + drift + momentum + impulse),
    anchor
  );

  engine.price = nextPrice;
  return nextPrice;
}

function engineHasListeners(engine: SymbolSyntheticEngine): boolean {
  return (
    engine.listeners["15s"].size > 0 ||
    engine.listeners["1m"].size > 0 ||
    engine.listeners["3m"].size > 0
  );
}

function listenerCount(engine: SymbolSyntheticEngine, timeframe?: Timeframe): number {
  if (timeframe) {
    return engine.listeners[timeframe].size;
  }

  return (
    engine.listeners["15s"].size +
    engine.listeners["1m"].size +
    engine.listeners["3m"].size
  );
}

function getTimeframeSeed(engine: SymbolSyntheticEngine, timeframe: Timeframe): Candle | null {
  let freshest: Candle | null = null;

  for (const seed of engine.seeds[timeframe].values()) {
    if (!seed) {
      continue;
    }

    if (!freshest || seed.time > freshest.time) {
      freshest = seed;
    }
  }

  return freshest ? cloneCandle(freshest) : null;
}

function timeframePreferenceRank(timeframe: Timeframe): number {
  switch (timeframe) {
    case "15s":
      return 3;
    case "1m":
      return 2;
    case "3m":
      return 1;
    default:
      return 0;
  }
}

function getBestSeedSelection(engine: SymbolSyntheticEngine): BestSeedSelection | null {
  let best: BestSeedSelection | null = null;

  for (const timeframe of ["15s", "1m", "3m"] as const) {
    const seed = getTimeframeSeed(engine, timeframe);
    if (!seed) {
      continue;
    }

    const expanded = subdivideSeedTo15s(seed, timeframe);
    const target15s = expanded[expanded.length - 1] ?? null;
    if (!target15s) {
      continue;
    }

    if (
      !best ||
      target15s.time > best.target15s.time ||
      (target15s.time === best.target15s.time &&
        timeframePreferenceRank(timeframe) > timeframePreferenceRank(best.timeframe))
    ) {
      best = {
        timeframe,
        expanded,
        target15s,
      };
    }
  }

  return best;
}

function getBestSeedTimeframe(engine: SymbolSyntheticEngine): Timeframe | null {
  return getBestSeedSelection(engine)?.timeframe ?? null;
}

function syncEngineToBestSeed(engine: SymbolSyntheticEngine): void {
  const bestSeedSelection = getBestSeedSelection(engine);
  if (!bestSeedSelection) {
    engine.finalized15s = [];
    engine.current15s = null;
    engine.price = null;
    engine.anchorPrice = null;
    resetEngineDynamics(engine);
    return;
  }

  const nextTarget15s = bestSeedSelection.target15s;
  const nextFinalized15s = bestSeedSelection.expanded.slice(0, -1);

  if (!engine.current15s || nextTarget15s.time > engine.current15s.time) {
    engine.finalized15s = mergeFinalized15s(
      engine.finalized15s,
      nextFinalized15s,
      nextTarget15s.time
    );
    engine.current15s = cloneCandle(nextTarget15s);
    engine.price = nextTarget15s.close;
    engine.anchorPrice = nextTarget15s.close;
    resetEngineDynamics(engine);
    return;
  }

  if (nextTarget15s.time === engine.current15s.time) {
    engine.finalized15s = mergeFinalized15s(
      engine.finalized15s,
      nextFinalized15s,
      nextTarget15s.time
    );
    engine.anchorPrice = nextTarget15s.close;
    engine.current15s = {
      ...engine.current15s,
      symbol: nextTarget15s.symbol,
      time: nextTarget15s.time,
      high: roundPrice(
        Math.max(
          engine.current15s.high,
          nextTarget15s.high,
          engine.price ?? engine.current15s.close
        ),
        nextTarget15s.close
      ),
      low: roundPrice(
        Math.min(
          engine.current15s.low,
          nextTarget15s.low,
          engine.price ?? engine.current15s.close
        ),
        nextTarget15s.close
      ),
      close: roundPrice(engine.price ?? engine.current15s.close, nextTarget15s.close),
    };
  }
}

function clearEngineInterval(engine: SymbolSyntheticEngine): void {
  if (engine.intervalId !== null) {
    window.clearInterval(engine.intervalId);
    engine.intervalId = null;
  }
}

function cleanupEngine(symbolKey: string, engine: SymbolSyntheticEngine): void {
  clearEngineInterval(engine);
  relayFastTickDebugLog("fast_tick:symbol", {
    action: "cleanup",
    symbol: symbolKey,
    listeners: {
      "15s": engine.listeners["15s"].size,
      "1m": engine.listeners["1m"].size,
      "3m": engine.listeners["3m"].size,
    },
    current15sTime: engine.current15s?.time ?? null,
  });
  engines.delete(symbolKey);
}

function createEngine(symbol: string): SymbolSyntheticEngine {
  return {
    symbol,
    listeners: createEmptyListenerMap(),
    seeds: createEmptySeedMap(),
    intervalId: null,
    finalized15s: [],
    current15s: null,
    price: null,
    anchorPrice: null,
    driftBias: 0,
    impulse: 0,
    impulseTicksRemaining: 0,
    noiseState: hashSymbol(symbol),
    tickCount: 0,
  };
}

function getOrCreateEngine(symbol: string): SymbolSyntheticEngine {
  const normalizedSymbol = normalizeSymbol(symbol);
  const existing = engines.get(normalizedSymbol);
  if (existing) {
    return existing;
  }

  const next = createEngine(normalizedSymbol);
  engines.set(normalizedSymbol, next);
  return next;
}

function advanceEngineToCurrent15sBucket(engine: SymbolSyntheticEngine): void {
  if (!engine.current15s) {
    return;
  }

  const currentBucket = alignCandleTime(Math.floor(Date.now() / 1000), "15s");
  if (currentBucket <= engine.current15s.time) {
    return;
  }

  let current = engine.current15s;

  while (current.time < currentBucket) {
    engine.finalized15s = trimFinalized15s([...engine.finalized15s, cloneCandle(current)]);
    const nextTime = current.time + timeframeToSeconds("15s");
    const nextOpen = engine.price ?? current.close;
    current = {
      symbol: engine.symbol,
      time: nextTime,
      open: nextOpen,
      high: nextOpen,
      low: nextOpen,
      close: nextOpen,
    };
    carryDynamicsAcrossRollover(engine);
  }

  engine.current15s = current;
  if (engine.price === null) {
    engine.price = current.close;
  }
}

function aggregate15sWindow(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[]
): Candle | null {
  if (candles.length === 0) {
    return null;
  }

  const sorted = [...candles].sort((left, right) => left.time - right.time);
  const open = sorted[0];
  const close = sorted[sorted.length - 1];

  return {
    symbol,
    time: alignCandleTime(open.time, timeframe),
    open: open.open,
    high: Math.max(...sorted.map((candle) => candle.high)),
    low: Math.min(...sorted.map((candle) => candle.low)),
    close: close.close,
    volume: sorted.reduce(
      (sum, candle) => sum + (typeof candle.volume === "number" ? candle.volume : 0),
      0
    ),
  };
}

function deriveCurrentTimeframeCandle(
  engine: SymbolSyntheticEngine,
  timeframe: Timeframe
): Candle | null {
  const current15s = engine.current15s;
  if (!current15s) {
    return getTimeframeSeed(engine, timeframe);
  }

  if (timeframe === "15s") {
    return cloneCandle(current15s);
  }

  const bucketStart = alignCandleTime(current15s.time, timeframe);
  const bucketEnd = bucketStart + timeframeToSeconds(timeframe);
  const bars = engine.finalized15s
    .filter((candle) => candle.time >= bucketStart && candle.time < bucketEnd)
    .concat(current15s.time >= bucketStart && current15s.time < bucketEnd ? [current15s] : []);

  return aggregate15sWindow(engine.symbol, timeframe, bars);
}

function emitTick(engine: SymbolSyntheticEngine): void {
  if (!engineHasListeners(engine)) {
    return;
  }

  syncEngineToBestSeed(engine);
  advanceEngineToCurrent15sBucket(engine);

  const current15s = engine.current15s;
  if (!current15s) {
    return;
  }

  engine.tickCount += 1;
  const nextPrice = evolveEnginePrice(engine);
  const reference = engine.anchorPrice ?? nextPrice;

  engine.current15s = {
    ...current15s,
    close: nextPrice,
    high: roundPrice(
      Math.max(current15s.high, nextPrice),
      reference
    ),
    low: roundPrice(
      Math.min(current15s.low, nextPrice),
      reference
    ),
  };

  for (const timeframe of ["15s", "1m", "3m"] as const) {
    const listeners = engine.listeners[timeframe];
    if (listeners.size === 0) {
      continue;
    }

    const nextCandle = deriveCurrentTimeframeCandle(engine, timeframe);
    if (!nextCandle) {
      continue;
    }

    for (const listener of Array.from(listeners.values())) {
      listener(cloneCandle(nextCandle));
    }
  }
}

function ensureEngineRunning(symbolKey: string, engine: SymbolSyntheticEngine): void {
  if (engine.intervalId !== null || !engineHasListeners(engine) || !engine.current15s) {
    return;
  }

  engine.intervalId = window.setInterval(() => {
    const current = engines.get(symbolKey);
    if (!current) {
      return;
    }

    if (!engineHasListeners(current)) {
      cleanupEngine(symbolKey, current);
      return;
    }

    emitTick(current);
  }, FAST_TICK_INTERVAL_MS);

  relayFastTickDebugLog("fast_tick:symbol", {
    action: "interval_started",
    symbol: symbolKey,
    intervalMs: FAST_TICK_INTERVAL_MS,
    listeners: {
      "15s": engine.listeners["15s"].size,
      "1m": engine.listeners["1m"].size,
      "3m": engine.listeners["3m"].size,
    },
    bestSeedTimeframe: getBestSeedTimeframe(engine),
    current15sTime: engine.current15s?.time ?? null,
  });
}

export function subscribeToFastTicks(
  symbol: string,
  timeframe: Timeframe,
  onTick: FastTickListener
): FastTickSubscription {
  const normalizedSymbol = normalizeSymbol(symbol);
  const contextKey = createContextKey(normalizedSymbol, timeframe);
  const engine = getOrCreateEngine(normalizedSymbol);
  const listenerId = nextListenerId++;

  engine.listeners[timeframe].set(listenerId, onTick);
  syncEngineToBestSeed(engine);
  ensureEngineRunning(normalizedSymbol, engine);

  relayFastTickDebugLog("fast_tick:symbol", {
    action: "subscribe",
    symbol: normalizedSymbol,
    contextKey,
    timeframe,
    listenerId,
    timeframeListenerCount: listenerCount(engine, timeframe),
    symbolListenerCount: listenerCount(engine),
    bestSeedTimeframe: getBestSeedTimeframe(engine),
  });

  return {
    unsubscribe: () => {
      const current = engines.get(normalizedSymbol);
      if (!current) {
        return;
      }

      current.listeners[timeframe].delete(listenerId);
      current.seeds[timeframe].delete(listenerId);
      syncEngineToBestSeed(current);

      relayFastTickDebugLog("fast_tick:symbol", {
        action: "unsubscribe",
        symbol: normalizedSymbol,
        contextKey,
        timeframe,
        listenerId,
        timeframeListenerCount: listenerCount(current, timeframe),
        symbolListenerCount: listenerCount(current),
        bestSeedTimeframe: getBestSeedTimeframe(current),
      });

      if (!engineHasListeners(current)) {
        cleanupEngine(normalizedSymbol, current);
      }
    },
    updateSeed: (candle) => {
      const current = engines.get(normalizedSymbol) ?? getOrCreateEngine(normalizedSymbol);
      current.seeds[timeframe].set(
        listenerId,
        candle ? normalizeSeedCandle(candle, timeframe) : null
      );
      syncEngineToBestSeed(current);
      ensureEngineRunning(normalizedSymbol, current);

      relayFastTickDebugLog("fast_tick:symbol", {
        action: candle ? "seed_updated" : "seed_cleared",
        symbol: normalizedSymbol,
        contextKey,
        timeframe,
        timeframeListenerCount: listenerCount(current, timeframe),
        symbolListenerCount: listenerCount(current),
        bestSeedTimeframe: getBestSeedTimeframe(current),
        seedTime: candle ? alignCandleTime(candle.time, timeframe) : null,
        current15sTime: current.current15s?.time ?? null,
      });
    },
  };
}
