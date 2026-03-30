import { useCallback, useEffect, useRef, useState } from "react";
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
const SUPPORTED_TIMEFRAMES: Timeframe[] = ["15s", "1m", "3m"];

type Panel = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
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
  const undoHistoryRef = useRef<(() => void) | null>(null);
  const redoHistoryRef = useRef<(() => void) | null>(null);

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
  const [supportedSymbols, setSupportedSymbols] =
    useState<SupportedSymbol[]>(DEFAULT_SUPPORTED_SYMBOLS);

  const tool = useToolStore((state) => state.tool);
  const magnet = useToolStore((state) => state.magnet);
  const { theme } = useThemeStore();
  const { workspaces, setActiveWorkspace, createDefaultWorkspace } = useWorkspaceStore();
  const { setData: setCandleData } = useCandleStore();
  const panels = useLayoutState((state) => state.panels);

  const getReplayPanelState = useCallback(
    (panelId: string | null) => {
      if (!panelId) return null;

      const panel = panels.find((candidate) => candidate.id === panelId);
      if (!panel) return null;

      return {
        panel,
        candles: dataRef.current[panel.symbol]?.[panel.timeframe] ?? [],
      };
    },
    [panels]
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

  const fetchHistoricalDeduped = useCallback(
    async (
      request: HistoricalRequest & {
        force?: boolean;
      }
    ): Promise<Candle[]> => {
      const { symbol, timeframe, from, to, limit, force = false } = request;
      const loaded = loadedRangesRef.current[symbol]?.[timeframe] ?? createEmptyLoadedRange();

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
    []
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

    const targetPanelId = activeChart ?? panels[0]?.id ?? null;
    setIsReplay(true);
    setIsReplaySelectingStart(true);
    setReplaySelectionPanelId(targetPanelId);
    if (targetPanelId) {
      setActiveChart(targetPanelId);
    }
    setReplayStartTime(null);
    setReplayCursorTime(null);
    setReplayIndex(0);
  }, [activeChart, panels]);

  const armReplaySelection = useCallback(() => {
    const targetPanelId = activeChart ?? panels[0]?.id ?? null;
    setIsReplay(true);
    setIsPlaying(false);
    setIsReplaySelectingStart(true);
    setReplaySelectionPanelId(targetPanelId);
    if (targetPanelId) {
      setActiveChart(targetPanelId);
    }
  }, [activeChart, panels]);

  const handleReplayStart = useCallback(
    (payload: ReplayStartPayload) => {
      const resolved = resolveReplayPosition(payload.panelId, payload.timestamp);
      if (!resolved) return;

      setActiveChart(payload.panelId);
      setIsReplay(true);
      setIsReplaySelectingStart(false);
      setReplaySelectionPanelId(null);
      setIsPlaying(false);
      setReplayStartTime(resolved.timestamp);
      setReplayCursorTime(resolved.timestamp);
      setReplayIndex(resolved.index);
    },
    [resolveReplayPosition]
  );

  // Jump to specific time: fetch older history first when the requested time is outside the loaded window.
  const goToTime = useCallback(
    (targetTime: number) => {
      if (!activeChart) return;

      void (async () => {
        const panelState = getReplayPanelState(activeChart);
        if (!panelState) return;

        let oldestLoaded =
          loadedRangesRef.current[panelState.panel.symbol]?.[panelState.panel.timeframe]?.oldest ??
          panelState.candles[0]?.time ??
          null;
        let attempts = 0;

        while (oldestLoaded !== null && targetTime < oldestLoaded && attempts < 5) {
          const olderCandles = await loadOlderHistory(
            panelState.panel.symbol,
            panelState.panel.timeframe,
            oldestLoaded
          );

          if (olderCandles.length === 0) {
            break;
          }

          oldestLoaded =
            loadedRangesRef.current[panelState.panel.symbol]?.[panelState.panel.timeframe]
              ?.oldest ?? oldestLoaded;
          attempts += 1;
        }

        const resolved = resolveReplayPosition(activeChart, targetTime);
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
    [activeChart, getReplayPanelState, loadOlderHistory, resolveReplayPosition]
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
      theme: {
        mode: "dark" as const,
        preset: "professional" as const,
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
      }
    }

    void loadSupportedSymbols();

    return () => {
      cancelled = true;
    };
  }, []);

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

    async function loadHistoricalData() {
      for (const { id: symbol } of supportedSymbols) {
        for (const timeframe of SUPPORTED_TIMEFRAMES) {
          try {
            const candles = await fetchHistoricalDeduped(
              buildInitialHistoricalRequest(symbol, timeframe)
            );

            if (cancelled) {
              return;
            }

            if (candles.length > 0) {
              applyHistoricalCandles(symbol, timeframe, candles);
            }
          } catch (error) {
            console.error(`[App] Failed to load ${symbol}/${timeframe}:`, error);
          }
        }
      }
    }

    void loadHistoricalData();

    return () => {
      cancelled = true;
    };
  }, [applyHistoricalCandles, fetchHistoricalDeduped, supportedSymbols]);

  useEffect(() => {
    let cancelled = false;
    const subscriptions: Array<{ unsubscribe: () => Promise<void> | void }> = [];

    async function subscribeToLiveData() {
      try {
        for (const { id: symbol } of supportedSymbols) {
          for (const timeframe of SUPPORTED_TIMEFRAMES) {
            const subscription = await marketDataProvider.subscribeLive(
              symbol,
              timeframe,
              (incoming) => {
                if (cancelled) return;

                setData((prev) => {
                  const currentSymbolData = prev[symbol] ?? createEmptyTimeframeData();
                  const updated = upsertCandleSeries(
                    currentSymbolData[timeframe] ?? [],
                    incoming
                  );

                  const nextState = {
                    ...prev,
                    [symbol]: {
                      ...currentSymbolData,
                      [timeframe]: updated,
                    },
                  };

                  dataRef.current = nextState;
                  return nextState;
                });
              }
            );

            if (cancelled) {
              await subscription.unsubscribe();
              return;
            }

            subscriptions.push(subscription);
          }
        }
      } catch (error) {
        console.error("[App] Live subscription init error:", error);
      }
    }

    void subscribeToLiveData();

    return () => {
      cancelled = true;

      for (const subscription of subscriptions) {
        void subscription.unsubscribe();
      }
    };
  }, [supportedSymbols]);

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
