import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "./components/TopBar";
import LayoutManager from "./layout/LayoutManager";
import Sidebar from "./components/SideBar";
import ErrorBoundary from "./components/ErrorBoundary";
import { useToolStore } from "./store/useToolStore";
import { useThemeStore } from "./store/useThemeStore";
import { useWorkspaceStore } from "./store/useWorkspaceStore";
import { useCandleStore } from "./store/useCandleStore";
import { useLayoutState } from "./store/useLayoutState";
import { EMPTY_CHART_DRAWINGS } from "./types/drawings";
import { marketDataProvider } from "./data/providers";
import type { Candle, HistoricalRequest, SupportedSymbol, Timeframe } from "./types/marketData";
import type { ReplayStartPayload } from "./types/replay";
import { getSessionRange, type SessionKey } from "./types/sessions";
import {
  clearLegacyMarketDataCaches,
  sanitizeCachedCandleData,
  sanitizeCandleSeries,
} from "./utils/candleCache";
import { findCandleIndexAtOrBefore } from "./utils/replay";

const DATA_STORAGE_KEY = "chart-data-v2";
const LEGACY_DATA_STORAGE_KEYS = ["chart-data-v1"];
const MAX_HISTORY_BACKFILL_ATTEMPTS = 5;

type Panel = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
};

type MarketContextKey = `${string}::${Timeframe}`;

type RequiredMarketContext = {
  symbol: string;
  timeframe: Timeframe;
  key: MarketContextKey;
};

type LiveMarketSubscription = {
  unsubscribe: () => Promise<void> | void;
};

const DEFAULT_PANELS: Panel[] = [
  { id: "A", symbol: "nq", timeframe: "15s" },
  { id: "B", symbol: "es", timeframe: "15s" },
  { id: "C", symbol: "nq", timeframe: "1m" },
  { id: "D", symbol: "es", timeframe: "1m" },
  { id: "E", symbol: "nq", timeframe: "3m" },
  { id: "F", symbol: "es", timeframe: "3m" },
];

function createEmptyTimeframeData(): Record<Timeframe, Candle[]> {
  return { "15s": [], "1m": [], "3m": [] };
}

const initialDataState: Record<string, Record<Timeframe, Candle[]>> = {
  nq: createEmptyTimeframeData(),
  es: createEmptyTimeframeData(),
};
const DEFAULT_SUPPORTED_SYMBOLS: SupportedSymbol[] = [
  { id: "nq", label: "NASDAQ" },
  { id: "es", label: "S&P 500" },
];

function makeMarketContextKey(symbol: string, timeframe: Timeframe): MarketContextKey {
  return `${symbol}::${timeframe}` as MarketContextKey;
}

function getVisiblePanelsForLayout(
  panels: Panel[],
  layoutType: string,
  focusedPanelId: string | null
): Panel[] {
  if (focusedPanelId) {
    const focusedPanel = panels.find((panel) => panel.id === focusedPanelId);
    return focusedPanel ? [focusedPanel] : [];
  }

  const visibleCount =
    layoutType === "2" ? 2 : layoutType === "3" ? 3 : layoutType === "6" ? 6 : panels.length;

  return panels.slice(0, visibleCount);
}

function getRequiredMarketContexts(
  panels: Array<Pick<Panel, "symbol" | "timeframe">>
): RequiredMarketContext[] {
  const seen = new Set<string>();
  const result: RequiredMarketContext[] = [];

  for (const panel of panels) {
    const key = makeMarketContextKey(panel.symbol, panel.timeframe);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      symbol: panel.symbol,
      timeframe: panel.timeframe,
      key,
    });
  }

  return result;
}

function readStoredData(): Record<string, Record<Timeframe, Candle[]>> {
  if (typeof window === "undefined") return initialDataState;

  try {
    clearLegacyMarketDataCaches(window.localStorage, LEGACY_DATA_STORAGE_KEYS);
    const stored = window.localStorage.getItem(DATA_STORAGE_KEY);
    if (!stored) return initialDataState;

    const parsed = sanitizeCachedCandleData(JSON.parse(stored));
    const merged: Record<string, Record<Timeframe, Candle[]>> = {
      nq: createEmptyTimeframeData(),
      es: createEmptyTimeframeData(),
    };

    for (const [symbol, series] of Object.entries(parsed)) {
      const current = merged[symbol] ?? createEmptyTimeframeData();

      merged[symbol] = {
        "15s": sanitizeCandleSeries(symbol, "15s", series["15s"] ?? current["15s"]),
        "1m": sanitizeCandleSeries(symbol, "1m", series["1m"] ?? current["1m"]),
        "3m": sanitizeCandleSeries(symbol, "3m", series["3m"] ?? current["3m"]),
      };
    }

    return merged;
  } catch (error) {
    console.error("[App] Failed to read cached data:", error);
    return initialDataState;
  }
}

function upsertCandleSeries(current: Candle[], incoming: Candle): Candle[] {
  const maxCandles = 500;

  if (current.length === 0) return [incoming];

  const next = [...current];
  const lastIndex = next.length - 1;
  const last = next[lastIndex];

  if (incoming.time > last.time) {
    next.push(incoming);
  } else if (incoming.time === last.time) {
    next[lastIndex] = incoming;
  }

  if (next.length > maxCandles) {
    next.splice(0, next.length - maxCandles);
  }

  return next;
}

function mergeHistoricalSeries(existing: Candle[], historical: Candle[]): Candle[] {
  if (historical.length === 0) return existing;

  const merged = [...historical];

  for (const live of existing) {
    const index = merged.findIndex((candle) => candle.time === live.time);
    if (index !== -1) {
      merged[index] = live;
    } else if (live.time > merged[merged.length - 1].time) {
      merged.push(live);
    }
  }

  return merged;
}

type LoadedRange = {
  oldest: number | null;
  newest: number | null;
};

type LoadedRangesState = Record<string, Record<Timeframe, LoadedRange>>;

type ReplayHistoryStatus = "idle" | "loading" | "failed";

type ResolvedReplayPosition = {
  panel: Panel;
  candles: Candle[];
  index: number;
  timestamp: number;
};

type ReplayHistoryResolution = {
  resolved: ResolvedReplayPosition | null;
  didBackfill: boolean;
  contextChanged: boolean;
};

type ProviderNotice = {
  tone: "warning" | "error";
  message: string;
};

function createEmptyLoadedRange(): LoadedRange {
  return {
    oldest: null,
    newest: null,
  };
}

function createEmptyLoadedRangeMap(): Record<Timeframe, LoadedRange> {
  return {
    "15s": createEmptyLoadedRange(),
    "1m": createEmptyLoadedRange(),
    "3m": createEmptyLoadedRange(),
  };
}

function createLoadedRangesState(symbolIds: string[]): LoadedRangesState {
  return Object.fromEntries(
    symbolIds.map((symbolId) => [symbolId, createEmptyLoadedRangeMap()])
  ) as LoadedRangesState;
}

function createPanelContextKey(panel: Panel): string {
  return `${panel.id}:${panel.symbol}:${panel.timeframe}`;
}

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

function buildInitialHistoricalRequest(symbol: string, timeframe: Timeframe) {
  const step = timeframeSeconds(timeframe);
  const limit = timeframe === "15s" ? 600 : timeframe === "1m" ? 500 : 400;
  const now = Math.floor(Date.now() / 1000);
  const to = now - (now % step);
  const from = to - (limit - 1) * step;

  return {
    symbol,
    timeframe,
    from,
    to,
    limit,
  };
}

function getLoadedRangeFromCandles(candles: Candle[]): LoadedRange {
  if (candles.length === 0) {
    return createEmptyLoadedRange();
  }

  return {
    oldest: candles[0]?.time ?? null,
    newest: candles[candles.length - 1]?.time ?? null,
  };
}

function makeRangeRequestKey(
  symbol: string,
  timeframe: Timeframe,
  from: number | null | undefined,
  to: number | null | undefined,
  limit: number | null | undefined
) {
  return `${symbol}:${timeframe}:${from ?? "null"}:${to ?? "null"}:${limit ?? "null"}`;
}

function isRangeCovered(
  loaded: LoadedRange | null | undefined,
  from: number | null | undefined,
  to: number | null | undefined
) {
  if (!loaded || loaded.oldest === null || loaded.newest === null) {
    return false;
  }

  if (from != null && from < loaded.oldest) {
    return false;
  }

  if (to != null && to > loaded.newest) {
    return false;
  }

  return true;
}

function mergeCandlesPreservingOrder(existing: Candle[], incoming: Candle[]) {
  const byTime = new Map<number, Candle>();

  for (const candle of existing) {
    byTime.set(candle.time, candle);
  }

  for (const candle of incoming) {
    byTime.set(candle.time, candle);
  }

  return Array.from(byTime.values()).sort((left, right) => left.time - right.time);
}

// ─── Historical Loader ────────────────────────────────────────────────────────

async function loadHistorical(
  symbol: string,
  tf: Timeframe,
  setData: React.Dispatch<React.SetStateAction<typeof initialDataState>>
) {
  try {
    const candles = await marketDataProvider.getHistorical({
      symbol,
      timeframe: tf,
    });

    if (!candles || candles.length === 0) return;

    setData((prev) => {
      const existing = prev[symbol]?.[tf] ?? [];

      // Historical candles form the base — live candles sit on top
      const merged = mergeHistoricalSeries(existing, candles);

      return {
        ...prev,
        [symbol]: {
          ...prev[symbol],
          [tf]: merged,
        },
      };
    });
  } catch (err) {
    console.warn(`[historical] Failed for ${symbol}/${tf}:`, err);
  }
}
void loadHistorical;

// ─────────────────────────────────────────────────────────────────────────────

// Binary search: find candle index by UNIX timestamp
function findIndexByTime(data: Candle[], targetTime: number): number {
  if (data.length === 0) return 0;
  if (targetTime <= data[0].time) return 0;
  if (targetTime >= data[data.length - 1].time) return data.length - 1;

  let left = 0;
  let right = data.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const time = data[mid].time;

    if (time === targetTime) return mid;
    if (time < targetTime) left = mid + 1;
    else right = mid - 1;
  }

  return left; // nearest future candle
}
void findIndexByTime;

// ─────────────────────────────────────────────────────────────────────────────

function AppInner() {
  const [data, setData] = useState(() => readStoredData());
  const dataRef = useRef(data);
  const [loadedRanges, setLoadedRanges] = useState<LoadedRangesState>(() =>
    createLoadedRangesState(DEFAULT_SUPPORTED_SYMBOLS.map(({ id }) => id))
  );
  const loadedRangesRef = useRef(loadedRanges);
  const inFlightHistoricalRequestsRef = useRef<Map<string, Promise<Candle[]>>>(new Map());
  const liveSubscriptionsRef = useRef<Map<MarketContextKey, LiveMarketSubscription>>(new Map());
  const pendingLiveSubscriptionsRef = useRef<Set<MarketContextKey>>(new Set());
  const requiredContextsRef = useRef<RequiredMarketContext[]>([]);
  const undoHistoryRef = useRef<(() => void) | null>(null);
  const redoHistoryRef = useRef<(() => void) | null>(null);
  const replayHistoryRequestIdRef = useRef(0);
  const replayPanelContextRef = useRef<string | null>(null);

  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [layoutType, setLayoutType] = useState("2");
  
  // Replay engine state
  const [isReplay, setIsReplay] = useState(false);
  const [isReplaySelectingStart, setIsReplaySelectingStart] = useState(false);
  const [replaySelectionPanelId, setReplaySelectionPanelId] = useState<string | null>(null);
  const [replayStartTime, setReplayStartTime] = useState<number | null>(null);
  const [replayCursorTime, setReplayCursorTime] = useState<number | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<0.5 | 1 | 2 | 5>(1);
  const [isReplaySync, setIsReplaySync] = useState(false);
  const [jumpTime, setJumpTime] = useState("");
  const [showSessions, setShowSessions] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [replayHistoryStatus, setReplayHistoryStatus] =
    useState<ReplayHistoryStatus>("idle");
  const [replayHistoryMessage, setReplayHistoryMessage] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<ProviderNotice | null>(null);
  const [supportedSymbols, setSupportedSymbols] =
    useState<SupportedSymbol[]>(DEFAULT_SUPPORTED_SYMBOLS);

  const tool = useToolStore((state) => state.tool);
  const magnet = useToolStore((state) => state.magnet);
  const { theme } = useThemeStore();
  const { workspaces, setActiveWorkspace, createDefaultWorkspace } = useWorkspaceStore();
  const { setData: setCandleData } = useCandleStore();
  const panels = useLayoutState((state) => state.panels);
  const focusedPanelId = useLayoutState((state) => state.focusedPanelId);
  const layoutPanels = panels.length > 0 ? panels : DEFAULT_PANELS;
  const visiblePanels = useMemo(
    () => getVisiblePanelsForLayout(layoutPanels, layoutType, focusedPanelId),
    [focusedPanelId, layoutPanels, layoutType]
  );
  const requiredContexts = useMemo(
    () => getRequiredMarketContexts(visiblePanels),
    [visiblePanels]
  );

  const getReplayPanelState = useCallback(
    (panelId: string | null) => {
      if (!panelId) return null;

      const panel = layoutPanels.find((candidate) => candidate.id === panelId);
      if (!panel) return null;

      return {
        panel,
        candles: dataRef.current[panel.symbol]?.[panel.timeframe] ?? [],
      };
    },
    [layoutPanels]
  );

  const resolveReplayPosition = useCallback(
    (panelId: string | null, targetTime: number) => {
      const panelState = getReplayPanelState(panelId);
      if (!panelState || panelState.candles.length === 0) return null;

      const index = findCandleIndexAtOrBefore(panelState.candles, targetTime);
      const timestamp = panelState.candles[index]?.time ?? targetTime;

      return {
        ...panelState,
        index,
        timestamp,
      };
    },
    [getReplayPanelState]
  );

  const registerHistoryControls = useCallback(
    (controls: {
      canUndo: boolean;
      canRedo: boolean;
      undo: () => void;
      redo: () => void;
    }) => {
      setCanUndo(controls.canUndo);
      setCanRedo(controls.canRedo);
      undoHistoryRef.current = controls.undo;
      redoHistoryRef.current = controls.redo;
    },
    []
  );

  const undoDrawings = useCallback(() => {
    undoHistoryRef.current?.();
  }, []);

  const redoDrawings = useCallback(() => {
    redoHistoryRef.current?.();
  }, []);

  const showProviderNotice = useCallback((tone: ProviderNotice["tone"], message: string) => {
    setProviderNotice((current) =>
      current?.tone === tone && current.message === message ? current : { tone, message }
    );
  }, []);

  const clearProviderNotice = useCallback(
    (predicate?: (notice: ProviderNotice) => boolean) => {
      setProviderNotice((current) => {
        if (!current) {
          return current;
        }

        if (!predicate || predicate(current)) {
          return null;
        }

        return current;
      });
    },
    []
  );

  const clearReplayHistoryFeedback = useCallback(() => {
    setReplayHistoryStatus("idle");
    setReplayHistoryMessage(null);
  }, []);

  const invalidateReplayHistoryFeedback = useCallback(() => {
    replayHistoryRequestIdRef.current += 1;
    clearReplayHistoryFeedback();
  }, [clearReplayHistoryFeedback]);

  const getRetainedLoadedRange = useCallback((symbol: string, timeframe: Timeframe) => {
    const retainedCandles = dataRef.current[symbol]?.[timeframe] ?? [];
    if (retainedCandles.length > 0) {
      return getLoadedRangeFromCandles(retainedCandles);
    }

    return loadedRangesRef.current[symbol]?.[timeframe] ?? createEmptyLoadedRange();
  }, []);

  const fetchHistoricalDeduped = useCallback(
    async (
      request: HistoricalRequest & {
        force?: boolean;
      }
    ): Promise<Candle[]> => {
      const { symbol, timeframe, from, to, limit, force = false } = request;
      const loaded = getRetainedLoadedRange(symbol, timeframe);

      if (!force && isRangeCovered(loaded, from, to)) {
        return [];
      }

      const key = makeRangeRequestKey(symbol, timeframe, from, to, limit);
      const existing = inFlightHistoricalRequestsRef.current.get(key);
      if (existing) {
        return existing;
      }

      const promise = marketDataProvider
        .getHistorical({ symbol, timeframe, from, to, limit })
        .finally(() => {
          inFlightHistoricalRequestsRef.current.delete(key);
        });

      inFlightHistoricalRequestsRef.current.set(key, promise);
      return promise;
    },
    [getRetainedLoadedRange]
  );

  const applyHistoricalCandles = useCallback(
    (symbol: string, timeframe: Timeframe, candles: Candle[]) => {
      if (candles.length === 0) {
        return;
      }

      const currentSymbolData = dataRef.current[symbol] ?? createEmptyTimeframeData();
      const merged = mergeCandlesPreservingOrder(currentSymbolData[timeframe] ?? [], candles);
      const nextState = {
        ...dataRef.current,
        [symbol]: {
          ...currentSymbolData,
          [timeframe]: merged,
        },
      };
      const mergedRange = getLoadedRangeFromCandles(merged);

      dataRef.current = nextState;
      setData(nextState);
      setCandleData(symbol, timeframe, merged);
      setLoadedRanges((prev) => {
        const currentSymbolRanges = prev[symbol] ?? createEmptyLoadedRangeMap();
        const nextRanges = {
          ...prev,
          [symbol]: {
            ...currentSymbolRanges,
            [timeframe]: mergedRange,
          },
        };

        loadedRangesRef.current = nextRanges;
        return nextRanges;
      });
    },
    [setCandleData]
  );

  const loadOlderHistory = useCallback(
    async (symbol: string, timeframe: Timeframe, currentOldest: number | null) => {
      if (currentOldest === null) {
        return [];
      }

      const step = timeframeSeconds(timeframe);
      const limit = timeframe === "15s" ? 600 : timeframe === "1m" ? 500 : 400;
      const to = currentOldest - step;

      if (to <= 0) {
        return [];
      }

      const from = to - (limit - 1) * step;

      try {
        const candles = await fetchHistoricalDeduped({
          symbol,
          timeframe,
          from,
          to,
          limit,
        });

        if (candles.length > 0) {
          applyHistoricalCandles(symbol, timeframe, candles);
        }

        return candles;
      } catch (error) {
        console.error(`[App] Failed to backfill ${symbol}/${timeframe}:`, error);
        return [];
      }
    },
    [applyHistoricalCandles, fetchHistoricalDeduped]
  );

  const ensureHistoryForTimestamp = useCallback(
    async (panelId: string | null, targetTimestamp: number): Promise<ReplayHistoryResolution> => {
      let panelState = getReplayPanelState(panelId);
      if (!panelState) {
        return {
          resolved: null,
          didBackfill: false,
          contextChanged: false,
        };
      }

      const initialPanelContext = createPanelContextKey(panelState.panel);
      let didBackfill = false;
      let attempts = 0;

      // Re-read the panel state each loop so a symbol/timeframe switch does not
      // keep backfilling stale history for a panel that changed context mid-request.
      while (attempts < MAX_HISTORY_BACKFILL_ATTEMPTS) {
        panelState = getReplayPanelState(panelId);
        if (!panelState) {
          return {
            resolved: null,
            didBackfill,
            contextChanged: false,
          };
        }

        if (createPanelContextKey(panelState.panel) !== initialPanelContext) {
          return {
            resolved: null,
            didBackfill,
            contextChanged: true,
          };
        }

        const oldestLoaded =
          getRetainedLoadedRange(panelState.panel.symbol, panelState.panel.timeframe).oldest ??
          panelState.candles[0]?.time ??
          null;

        if (oldestLoaded === null || targetTimestamp >= oldestLoaded) {
          break;
        }

        const olderCandles = await loadOlderHistory(
          panelState.panel.symbol,
          panelState.panel.timeframe,
          oldestLoaded
        );
        didBackfill = true;

        if (olderCandles.length === 0) {
          break;
        }

        attempts += 1;
      }

      panelState = getReplayPanelState(panelId);
      if (!panelState) {
        return {
          resolved: null,
          didBackfill,
          contextChanged: false,
        };
      }

      if (createPanelContextKey(panelState.panel) !== initialPanelContext) {
        return {
          resolved: null,
          didBackfill,
          contextChanged: true,
        };
      }

      const finalOldestLoaded =
        getRetainedLoadedRange(panelState.panel.symbol, panelState.panel.timeframe).oldest ??
        panelState.candles[0]?.time ??
        null;

      if (finalOldestLoaded !== null && targetTimestamp < finalOldestLoaded) {
        return {
          resolved: null,
          didBackfill,
          contextChanged: false,
        };
      }

      return {
        resolved: resolveReplayPosition(panelId, targetTimestamp),
        didBackfill,
        contextChanged: false,
      };
    },
    [getReplayPanelState, getRetainedLoadedRange, loadOlderHistory, resolveReplayPosition]
  );

  const resolveReplayTargetWithHistory = useCallback(
    async (panelId: string | null, targetTimestamp: number, source: "start" | "jump") => {
      const panelState = getReplayPanelState(panelId);
      if (!panelState) {
        return null;
      }

      const panelContext = createPanelContextKey(panelState.panel);
      const oldestLoaded =
        getRetainedLoadedRange(panelState.panel.symbol, panelState.panel.timeframe).oldest ??
        panelState.candles[0]?.time ??
        null;
      const needsBackfill = oldestLoaded !== null && targetTimestamp < oldestLoaded;
      const requestId = replayHistoryRequestIdRef.current + 1;

      replayHistoryRequestIdRef.current = requestId;

      if (needsBackfill) {
        setReplayHistoryStatus("loading");
        setReplayHistoryMessage(
          source === "start"
            ? "Loading older history for replay start..."
            : "Loading older history for jump target..."
        );
      } else {
        clearReplayHistoryFeedback();
      }

      const result = await ensureHistoryForTimestamp(panelId, targetTimestamp);

      if (replayHistoryRequestIdRef.current !== requestId) {
        return null;
      }

      const currentPanelState = getReplayPanelState(panelId);
      if (
        result.contextChanged ||
        !currentPanelState ||
        createPanelContextKey(currentPanelState.panel) !== panelContext
      ) {
        clearReplayHistoryFeedback();
        return null;
      }

      if (!result.resolved) {
        if (needsBackfill || result.didBackfill) {
          setReplayHistoryStatus("failed");
          setReplayHistoryMessage(
            source === "start"
              ? "Could not load enough older history for that replay start."
              : "Could not load enough older history for that jump target."
          );
        } else {
          clearReplayHistoryFeedback();
        }

        return null;
      }

      clearReplayHistoryFeedback();
      return result.resolved;
    },
    [clearReplayHistoryFeedback, ensureHistoryForTimestamp, getReplayPanelState, getRetainedLoadedRange]
  );

  const moveReplayCursor = useCallback(
    (direction: -1 | 1) => {
      if (!isReplay || isReplaySelectingStart || !activeChart) return false;

      const panelState = getReplayPanelState(activeChart);
      if (!panelState || panelState.candles.length === 0) return false;

      const currentIndex =
        isReplaySync && replayCursorTime !== null
          ? findCandleIndexAtOrBefore(panelState.candles, replayCursorTime)
          : Math.max(0, Math.min(replayIndex, panelState.candles.length - 1));
      const nextIndex = Math.max(
        0,
        Math.min(panelState.candles.length - 1, currentIndex + direction)
      );

      if (nextIndex === currentIndex) {
        return false;
      }

      const nextTimestamp = panelState.candles[nextIndex]?.time;
      if (typeof nextTimestamp !== "number") {
        return false;
      }

      setReplayIndex(nextIndex);
      setReplayCursorTime(nextTimestamp);
      return true;
    },
    [
      activeChart,
      getReplayPanelState,
      isReplay,
      isReplaySelectingStart,
      isReplaySync,
      replayCursorTime,
      replayIndex,
    ]
  );

  const stepForward = useCallback(() => {
    moveReplayCursor(1);
  }, [moveReplayCursor]);

  const stepBackward = useCallback(() => {
    moveReplayCursor(-1);
  }, [moveReplayCursor]);

  const resetReplay = useCallback(() => {
    if (!activeChart || replayStartTime === null) return;

    const resolved = resolveReplayPosition(activeChart, replayStartTime);
    if (!resolved) return;

    setIsPlaying(false);
    setReplayIndex(resolved.index);
    setReplayCursorTime(resolved.timestamp);
  }, [activeChart, replayStartTime, resolveReplayPosition]);

  const handleReplayToggle = useCallback((nextIsReplay: boolean) => {
    invalidateReplayHistoryFeedback();
    setIsPlaying(false);

    if (!nextIsReplay) {
      setIsReplay(false);
      setIsReplaySelectingStart(false);
      setReplaySelectionPanelId(null);
      setReplayStartTime(null);
      setReplayCursorTime(null);
      setReplayIndex(0);
      return;
    }

    const targetPanelId = activeChart ?? visiblePanels[0]?.id ?? null;
    setIsReplay(true);
    setIsReplaySelectingStart(true);
    setReplaySelectionPanelId(targetPanelId);
    if (targetPanelId) {
      setActiveChart(targetPanelId);
    }
    setReplayStartTime(null);
    setReplayCursorTime(null);
    setReplayIndex(0);
  }, [activeChart, invalidateReplayHistoryFeedback, visiblePanels]);

  const armReplaySelection = useCallback(() => {
    invalidateReplayHistoryFeedback();
    const targetPanelId = activeChart ?? visiblePanels[0]?.id ?? null;
    setIsReplay(true);
    setIsPlaying(false);
    setIsReplaySelectingStart(true);
    setReplaySelectionPanelId(targetPanelId);
    if (targetPanelId) {
      setActiveChart(targetPanelId);
    }
  }, [activeChart, invalidateReplayHistoryFeedback, visiblePanels]);

  const handleReplayStart = useCallback(
    (payload: ReplayStartPayload) => {
      void (async () => {
        const resolved = await resolveReplayTargetWithHistory(
          payload.panelId,
          payload.timestamp,
          "start"
        );
        if (!resolved) return;

        setActiveChart(payload.panelId);
        setIsReplay(true);
        setIsReplaySelectingStart(false);
        setReplaySelectionPanelId(null);
        setIsPlaying(false);
        setReplayStartTime(resolved.timestamp);
        setReplayCursorTime(resolved.timestamp);
        setReplayIndex(resolved.index);
      })();
    },
    [resolveReplayTargetWithHistory]
  );

  // Jump to specific time: use the same backfill loop as replay-start so both flows stay aligned.
  const goToTime = useCallback(
    (targetTime: number) => {
      if (!activeChart) return;

      void (async () => {
        const resolved = await resolveReplayTargetWithHistory(activeChart, targetTime, "jump");
        if (!resolved) return;

        setIsReplay(true);
        setIsReplaySelectingStart(false);
        setReplaySelectionPanelId(null);
        setIsPlaying(false);
        setReplayIndex(resolved.index);
        setReplayCursorTime(resolved.timestamp);
        setReplayStartTime((current) => current ?? resolved.timestamp);
        console.log(
          `[Jump to Time] Moved to index ${resolved.index} (timestamp ${resolved.timestamp})`
        );
      })();
    },
    [activeChart, resolveReplayTargetWithHistory]
  );

  // Jump to session start time (e.g., "london", "newyork")
  const jumpToSession = (session: SessionKey) => {
    const now = new Date();
    const { start } = getSessionRange(now, session);
    goToTime(start);
  };

  // Autoplay: step forward at intervals based on playSpeed
  useEffect(() => {
    if (!isPlaying || !isReplay || isReplaySelectingStart) return;

    // Calculate interval based on speed (in ms per candle)
    const speedIntervals: Record<0.5 | 1 | 2 | 5, number> = {
      0.5: 600, // slow
      1: 300,   // normal
      2: 150,   // fast
      5: 60,    // very fast
    };

    const interval = setInterval(() => {
      const moved = moveReplayCursor(1);
      if (!moved) {
        setIsPlaying(false);
      }
    }, speedIntervals[playSpeed]);

    return () => clearInterval(interval);
  }, [isPlaying, isReplay, isReplaySelectingStart, moveReplayCursor, playSpeed]);

  useEffect(() => {
    if (!isReplay || !isReplaySync || replayCursorTime !== null || !activeChart) return;

    const panelState = getReplayPanelState(activeChart);
    if (!panelState || panelState.candles.length === 0) return;

    const safeIndex = Math.max(0, Math.min(replayIndex, panelState.candles.length - 1));
    const timestamp = panelState.candles[safeIndex]?.time;
    if (typeof timestamp === "number") {
      setReplayCursorTime(timestamp);
    }
  }, [activeChart, getReplayPanelState, isReplay, isReplaySync, replayCursorTime, replayIndex]);

  // Keep dataRef in sync with state (including historical loads)
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    loadedRangesRef.current = loadedRanges;
  }, [loadedRanges]);

  useEffect(() => {
    requiredContextsRef.current = requiredContexts;
  }, [requiredContexts]);

  useEffect(() => {
    const activePanel = activeChart
      ? layoutPanels.find((candidate) => candidate.id === activeChart) ?? null
      : null;
    const nextContext = activePanel ? createPanelContextKey(activePanel) : null;

    if (replayPanelContextRef.current === nextContext) {
      return;
    }

    replayPanelContextRef.current = nextContext;
    invalidateReplayHistoryFeedback();
  }, [activeChart, invalidateReplayHistoryFeedback, layoutPanels]);

  useEffect(() => {
    setLoadedRanges((prev) => {
      let changed = false;
      const nextRanges = { ...prev };

      for (const { id } of supportedSymbols) {
        if (nextRanges[id]) continue;
        nextRanges[id] = createEmptyLoadedRangeMap();
        changed = true;
      }

      if (!changed) {
        return prev;
      }

      loadedRangesRef.current = nextRanges;
      return nextRanges;
    });
  }, [supportedSymbols]);

  // Initialize default workspace if none exist
  useEffect(() => {
    if (workspaces.length > 0) return;

    const defaultWorkspace = {
      id: crypto.randomUUID(),
      name: "Default",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      layoutType: "2",
      panels: DEFAULT_PANELS,
      drawingsBySymbol: {
        nq: EMPTY_CHART_DRAWINGS,
        es: EMPTY_CHART_DRAWINGS,
      },
    };

    createDefaultWorkspace(defaultWorkspace);
    setActiveWorkspace(defaultWorkspace.id);
  }, [workspaces.length, createDefaultWorkspace, setActiveWorkspace]);

  useEffect(() => {
    let cancelled = false;

    async function loadSupportedSymbols() {
      try {
        const nextSymbols = await marketDataProvider.getSupportedSymbols();
        if (!cancelled && nextSymbols.length > 0) {
          clearProviderNotice(
            (notice) => notice.message === "Using default symbol list while provider symbols load."
          );
          setSupportedSymbols((current) => {
            const sameSymbols =
              current.length === nextSymbols.length &&
              current.every(
                (symbol, index) =>
                  symbol.id === nextSymbols[index]?.id &&
                  symbol.label === nextSymbols[index]?.label
              );

            return sameSymbols ? current : nextSymbols;
          });
        }
      } catch (error) {
        console.warn("[App] Falling back to default symbol list:", error);
        if (!cancelled) {
          showProviderNotice("warning", "Using default symbol list while provider symbols load.");
        }
      }
    }

    void loadSupportedSymbols();

    return () => {
      cancelled = true;
    };
  }, [clearProviderNotice, showProviderNotice]);

  // Persist chart data to localStorage on every change
  useEffect(() => {
    try {
      window.localStorage.setItem(DATA_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error("[App] Failed to cache chart data:", error);
    }
  }, [data]);

  // Apply theme CSS variables
  useEffect(() => {
    const root = document.documentElement;

    root.style.setProperty("--app-bg", theme.background);
    root.style.setProperty("--panel-bg", theme.panel);
    root.style.setProperty("--panel-border", theme.border);
    root.style.setProperty("--panel-text", theme.text);
    root.style.setProperty("--panel-muted", theme.muted);
    root.style.setProperty("--panel-accent", theme.accent);
    root.style.setProperty("--grid-color", theme.grid);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    let historicalLoadFailed = false;

    async function ensureVisibleHistoryLoaded() {
      for (const context of requiredContexts) {
        try {
          const candles = await fetchHistoricalDeduped(
            buildInitialHistoricalRequest(context.symbol, context.timeframe)
          );

          if (cancelled || candles.length === 0) {
            continue;
          }

          applyHistoricalCandles(context.symbol, context.timeframe, candles);
        } catch (error) {
          historicalLoadFailed = true;
          console.error(`[App] Failed to load ${context.key}:`, error);
        }
      }

      if (!cancelled && !historicalLoadFailed) {
        clearProviderNotice(
          (notice) => notice.message === "Some historical data could not be loaded."
        );
      }

      if (!cancelled && historicalLoadFailed) {
        showProviderNotice("error", "Some historical data could not be loaded.");
      }
    }

    void ensureVisibleHistoryLoaded();

    return () => {
      cancelled = true;
    };
  }, [
    applyHistoricalCandles,
    clearProviderNotice,
    fetchHistoricalDeduped,
    requiredContexts,
    showProviderNotice,
  ]);

  useEffect(() => {
    let cancelled = false;
    let subscriptionFailed = false;

    async function syncDemandDrivenSubscriptions() {
      const nextContexts = new Set(requiredContexts.map((context) => context.key));
      const currentSubscriptions = liveSubscriptionsRef.current;
      const pendingSubscriptions = pendingLiveSubscriptionsRef.current;

      for (const context of requiredContexts) {
        if (currentSubscriptions.has(context.key) || pendingSubscriptions.has(context.key)) {
          continue;
        }

        pendingSubscriptions.add(context.key);

        try {
          const subscription = await marketDataProvider.subscribeLive(
            context.symbol,
            context.timeframe,
            (incoming) => {
              if (cancelled) return;

              setData((prev) => {
                const currentSymbolData = prev[context.symbol] ?? createEmptyTimeframeData();
                const updated = upsertCandleSeries(
                  currentSymbolData[context.timeframe] ?? [],
                  incoming
                );

                const nextState = {
                  ...prev,
                  [context.symbol]: {
                    ...currentSymbolData,
                    [context.timeframe]: updated,
                  },
                };

                dataRef.current = nextState;
                return nextState;
              });
            }
          );

          const stillRequired = requiredContextsRef.current.some(
            (current) => current.key === context.key
          );

          if (cancelled || !stillRequired) {
            try {
              await subscription.unsubscribe();
            } catch (error) {
              subscriptionFailed = true;
              currentSubscriptions.set(context.key, subscription);
              console.error(`[App] Live unsubscribe error for ${context.key}:`, error);
            }
            continue;
          }

          currentSubscriptions.set(context.key, subscription);
        } catch (error) {
          subscriptionFailed = true;
          console.error(`[App] Live subscription error for ${context.key}:`, error);
        } finally {
          pendingSubscriptions.delete(context.key);
        }
      }

      for (const [key, subscription] of Array.from(currentSubscriptions.entries())) {
        if (nextContexts.has(key)) {
          continue;
        }

        try {
          await subscription.unsubscribe();
          currentSubscriptions.delete(key);
        } catch (error) {
          subscriptionFailed = true;
          console.error(`[App] Live unsubscribe error for ${key}:`, error);
        }
      }

      if (!cancelled && !subscriptionFailed) {
        clearProviderNotice(
          (notice) => notice.message === "Live data subscription failed for one or more streams."
        );
      }

      if (!cancelled && subscriptionFailed) {
        showProviderNotice("error", "Live data subscription failed for one or more streams.");
      }
    }

    void syncDemandDrivenSubscriptions();

    return () => {
      cancelled = true;
    };
  }, [clearProviderNotice, requiredContexts, showProviderNotice]);

  useEffect(() => {
    return () => {
      const subscriptions = Array.from(liveSubscriptionsRef.current.values());

      liveSubscriptionsRef.current.clear();
      pendingLiveSubscriptionsRef.current.clear();

      for (const subscription of subscriptions) {
        void subscription.unsubscribe();
      }
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="app-shell__toolbar">
        <TopBar
          layoutType={layoutType}
          setLayoutType={setLayoutType}
          isReplay={isReplay}
          setIsReplay={handleReplayToggle}
          isReplaySelectingStart={isReplaySelectingStart}
          armReplaySelection={armReplaySelection}
          replayStartTime={replayStartTime}
          replayCursorTime={replayCursorTime}
          replayIndex={replayIndex}
          stepForward={stepForward}
          stepBackward={stepBackward}
          resetReplay={resetReplay}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
          playSpeed={playSpeed}
          setPlaySpeed={setPlaySpeed}
          isReplaySync={isReplaySync}
          setIsReplaySync={setIsReplaySync}
          jumpTime={jumpTime}
          setJumpTime={setJumpTime}
          goToTime={goToTime}
          replayHistoryStatus={replayHistoryStatus}
          replayHistoryMessage={replayHistoryMessage}
          providerNotice={providerNotice}
          showSessions={showSessions}
          setShowSessions={setShowSessions}
          jumpToSession={jumpToSession}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undoDrawings}
          onRedo={redoDrawings}
        />
      </div>

      <div style={{ display: "flex", height: "100%" }}>
        <Sidebar />

        <div className="app-shell__viewport" style={{ flex: 1 }}>
          <LayoutManager
            data={data}
            layoutType={layoutType}
            activeChart={activeChart}
            setActiveChart={setActiveChart}
            tool={tool}
            magnet={magnet}
            isReplay={isReplay}
            isReplaySelectingStart={isReplaySelectingStart}
            replaySelectionPanelId={replaySelectionPanelId}
            replayStartTime={replayStartTime}
            replayCursorTime={replayCursorTime}
            replayIndex={replayIndex}
            isReplaySync={isReplaySync}
            onReplayStart={handleReplayStart}
            supportedSymbols={supportedSymbols}
            showSessions={showSessions}
            registerHistoryControls={registerHistoryControls}
          />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
