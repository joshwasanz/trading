import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import type {
  Candle,
  HistoricalRequest,
  HistoryUiSource,
  HistoryUiState,
  ProviderMode,
  SupportedSymbol,
  Timeframe,
} from "./types/marketData";
import type { ReplayStartPayload } from "./types/replay";
import { getSessionRange, type SessionKey } from "./utils/sessions";
import { DEFAULT_SMA_PERIOD, sanitizeIndicatorPeriod } from "./utils/indicators";
import {
  DEFAULT_PANELS,
  DEFAULT_LAYOUT_TYPE,
  DEFAULT_SUPPORTED_SYMBOLS,
  DEFAULT_SUPPORTED_SYMBOL_IDS,
  FREE_TIER_VALIDATION_MODE,
  isValidationModeSymbolAllowed,
  normalizeInstrumentId,
} from "./instruments";
import {
  loadScopedCandleCache,
  persistScopedCandleCache,
  sanitizeCandleSeries,
} from "./utils/candleCache";
import { findCandleIndexAtOrBefore } from "./utils/replay";

const DATA_STORAGE_KEY = "chart-data-v3";
const LEGACY_DATA_STORAGE_KEYS = ["chart-data-v1", "chart-data-v2"];
const MAX_HISTORY_BACKFILL_ATTEMPTS = 5;
const DEFAULT_SUPPORTED_TIMEFRAMES: Timeframe[] = ["1m", "3m"];
const DEBUG_LIVE_UPDATES = import.meta.env.DEV;

type ProviderStatusEvent = {
  kind: "error" | "info";
  source: string;
  symbol?: string | null;
  timeframe?: Timeframe | null;
  message: string;
};

type ValidationStatus = {
  lastLiveEventTime: number | null;
  lastMergeTime: number | null;
  lastProviderError: string | null;
};

function relayFrontendDebugLog(scope: string, payload: unknown) {
  if (!DEBUG_LIVE_UPDATES) {
    return;
  }

  void invoke("frontend_debug_log", {
    scope,
    payload: JSON.stringify(payload),
  }).catch(() => undefined);
}

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

function createEmptyTimeframeData(): Record<Timeframe, Candle[]> {
  return { "15s": [], "1m": [], "3m": [] };
}

function createInitialDataState(): Record<string, Record<Timeframe, Candle[]>> {
  return Object.fromEntries(
    DEFAULT_SUPPORTED_SYMBOL_IDS.map((symbolId) => [symbolId, createEmptyTimeframeData()])
  ) as Record<string, Record<Timeframe, Candle[]>>;
}

const initialDataState: Record<string, Record<Timeframe, Candle[]>> = createInitialDataState();

function makeMarketContextKey(symbol: string, timeframe: Timeframe): MarketContextKey {
  return `${symbol}::${timeframe}` as MarketContextKey;
}

function getVisiblePanelsForLayout(
  panels: Panel[],
  layoutType: string,
  focusedPanelId: string | null
): Panel[] {
  if (FREE_TIER_VALIDATION_MODE || panels.length <= 1 || layoutType === "1") {
    return panels.slice(0, 1);
  }

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

function readStoredData(providerMode: ProviderMode): Record<string, Record<Timeframe, Candle[]>> {
  if (typeof window === "undefined") return initialDataState;

  try {
    const parsed = loadScopedCandleCache(
      window.localStorage,
      DATA_STORAGE_KEY,
      LEGACY_DATA_STORAGE_KEYS,
      providerMode
    );
    const merged: Record<string, Record<Timeframe, Candle[]>> = createInitialDataState();

    for (const [symbol, series] of Object.entries(parsed)) {
      const normalizedSymbol = normalizeInstrumentId(symbol);
      if (FREE_TIER_VALIDATION_MODE && !isValidationModeSymbolAllowed(normalizedSymbol)) {
        relayFrontendDebugLog("validation:cache", {
          action: "blocked_hydration",
          symbol: normalizedSymbol,
        });
        continue;
      }

      const current = merged[normalizedSymbol] ?? createEmptyTimeframeData();
      const next15s = sanitizeCandleSeries(
        normalizedSymbol,
        "15s",
        series["15s"] ?? current["15s"]
      );
      const next1m = sanitizeCandleSeries(normalizedSymbol, "1m", series["1m"] ?? current["1m"]);
      const next3m = sanitizeCandleSeries(normalizedSymbol, "3m", series["3m"] ?? current["3m"]);

      merged[normalizedSymbol] = {
        "15s": FREE_TIER_VALIDATION_MODE
          ? current["15s"]
          : mergeCandlesPreservingOrder(current["15s"], next15s),
        "1m": mergeCandlesPreservingOrder(current["1m"], next1m),
        "3m": mergeCandlesPreservingOrder(current["3m"], next3m),
      };
    }

    return merged;
  } catch (error) {
    console.error("[App] Failed to read cached data:", error);
    return initialDataState;
  }
}

function candlesEqual(left: Candle, right: Candle): boolean {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close
  );
}

function trimRecentCandles(candles: Candle[], maxCandles: number): Candle[] {
  return candles.length > maxCandles
    ? candles.slice(candles.length - maxCandles)
    : candles;
}

type LiveMergeAction = "append" | "replace" | "insert" | "ignore";

type LiveMergeResult = {
  action: LiveMergeAction;
  candles: Candle[];
};

function liveRetentionLimit(timeframe: Timeframe): number {
  switch (timeframe) {
    case "15s":
      return 1200;
    case "1m":
      return 3000;
    case "3m":
      return 2000;
    default:
      return 1500;
  }
}

function mergeLiveCandleSeries(
  current: Candle[],
  incoming: Candle,
  timeframe: Timeframe
): LiveMergeResult {
  if (current.length === 0) {
    return { action: "append", candles: [incoming] };
  }

  const exactIndex = current.findIndex((candle) => candle.time === incoming.time);
  if (exactIndex >= 0) {
    if (candlesEqual(current[exactIndex], incoming)) {
      return { action: "ignore", candles: current };
    }

    const next = [...current];
    next[exactIndex] = incoming;
    return { action: "replace", candles: next };
  }

  const next = [...current];
  const insertIndex = next.findIndex((candle) => candle.time > incoming.time);
  const targetSize = Math.max(current.length, liveRetentionLimit(timeframe));

  if (insertIndex === -1) {
    next.push(incoming);
    return {
      action: "append",
      candles: trimRecentCandles(next, targetSize),
    };
  }

  next.splice(insertIndex, 0, incoming);
  return {
    action: "insert",
    candles: trimRecentCandles(next, targetSize),
  };
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
  failed: boolean;
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

function createIdleHistoryUiState(): HistoryUiState {
  return {
    status: "idle",
    message: null,
  };
}

function formatValidationTimestamp(timestamp: number | null): string {
  if (timestamp === null) {
    return "waiting";
  }

  return new Date(timestamp * 1_000).toLocaleTimeString();
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

function historicalRequestLimit(timeframe: Timeframe): number {
  switch (timeframe) {
    case "15s":
      return 600;
    case "1m":
      return 1500;
    case "3m":
      return 1200;
    default:
      return 500;
  }
}

function buildInitialHistoricalRequest(symbol: string, timeframe: Timeframe): HistoricalRequest {
  return {
    symbol,
    timeframe,
    from: undefined,
    to: undefined,
    limit: historicalRequestLimit(timeframe),
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

function createLoadedRangesFromData(
  data: Record<string, Record<Timeframe, Candle[]>>
): LoadedRangesState {
  const symbolIds = Array.from(new Set([...DEFAULT_SUPPORTED_SYMBOL_IDS, ...Object.keys(data)]));
  const ranges = createLoadedRangesState(symbolIds);

  for (const [symbol, series] of Object.entries(data)) {
    ranges[symbol] = {
      "15s": getLoadedRangeFromCandles(series["15s"] ?? []),
      "1m": getLoadedRangeFromCandles(series["1m"] ?? []),
      "3m": getLoadedRangeFromCandles(series["3m"] ?? []),
    };
  }

  return ranges;
}

function makeRangeRequestKey(
  providerMode: ProviderMode | "unknown",
  symbol: string,
  timeframe: Timeframe,
  from: number | null | undefined,
  to: number | null | undefined,
  limit: number | null | undefined
) {
  return `${providerMode}:${symbol}:${timeframe}:${from ?? "null"}:${to ?? "null"}:${limit ?? "null"}`;
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
  const [data, setData] = useState(() => initialDataState);
  const dataRef = useRef(data);
  const layoutPanelsRef = useRef<Panel[]>(DEFAULT_PANELS);
  const activeChartRef = useRef<string | null>(null);
  const isReplayRef = useRef(false);
  const isReplaySyncRef = useRef(false);
  const [loadedRanges, setLoadedRanges] = useState<LoadedRangesState>(() =>
    createLoadedRangesState(DEFAULT_SUPPORTED_SYMBOL_IDS)
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
  const [layoutType, setLayoutType] = useState(DEFAULT_LAYOUT_TYPE);
  
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
  const [showSessions, setShowSessions] = useState(true);
  const [showSessionLevels, setShowSessionLevels] = useState(true);
  const [showSessionRanges, setShowSessionRanges] = useState(true);
  const [showSma, setShowSma] = useState(false);
  const [smaPeriod, setSmaPeriod] = useState(DEFAULT_SMA_PERIOD);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [replayHistoryStatus, setReplayHistoryStatus] =
    useState<ReplayHistoryStatus>("idle");
  const [replayHistoryMessage, setReplayHistoryMessage] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<ProviderNotice | null>(null);
  const [providerMode, setProviderMode] = useState<ProviderMode | null>(null);
  const [providerCacheReady, setProviderCacheReady] = useState(false);
  const [providerLiveSource, setProviderLiveSource] = useState<string | null>(null);
  const [providerPollIntervalMs, setProviderPollIntervalMs] = useState<number | null>(null);
  const [strictRealtime, setStrictRealtime] = useState(false);
  const [supportedSymbols, setSupportedSymbols] =
    useState<SupportedSymbol[]>(DEFAULT_SUPPORTED_SYMBOLS);
  const [supportedTimeframes, setSupportedTimeframes] =
    useState<Timeframe[]>(DEFAULT_SUPPORTED_TIMEFRAMES);
  const [liveSupported, setLiveSupported] = useState(true);
  const [historyUiStates, setHistoryUiStates] =
    useState<Record<MarketContextKey, HistoryUiState>>({});
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>({
    lastLiveEventTime: null,
    lastMergeTime: null,
    lastProviderError: null,
  });

  useEffect(() => {
    relayFrontendDebugLog("startup", {
      stage: "app:mounted",
    });
    relayFrontendDebugLog("validation:mode", {
      enabled: FREE_TIER_VALIDATION_MODE,
    });
  }, []);

  const tool = useToolStore((state) => state.tool);
  const magnet = useToolStore((state) => state.magnet);
  const { theme } = useThemeStore();
  const { workspaces, setActiveWorkspace, createDefaultWorkspace } = useWorkspaceStore();
  const { setData: setCandleData, loadFromCache: loadCandleDataFromCache } = useCandleStore();
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
  const effectiveRequiredContexts = useMemo(() => {
    if (!FREE_TIER_VALIDATION_MODE) {
      return requiredContexts;
    }

    return requiredContexts.slice(0, 1);
  }, [requiredContexts]);

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

  const shouldApplyLiveUpdate = useCallback((symbol: string, timeframe: Timeframe) => {
    if (!isReplayRef.current) {
      return true;
    }

    if (isReplaySyncRef.current) {
      return false;
    }

    const activePanelId = activeChartRef.current;
    if (!activePanelId) {
      return true;
    }

    const activePanel = layoutPanelsRef.current.find((panel) => panel.id === activePanelId);
    if (!activePanel) {
      return true;
    }

    return !(activePanel.symbol === symbol && activePanel.timeframe === timeframe);
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

  const recordValidationProviderError = useCallback((message: string) => {
    if (!FREE_TIER_VALIDATION_MODE) {
      return;
    }

    setValidationStatus((current) =>
      current.lastProviderError === message
        ? current
        : {
            ...current,
            lastProviderError: message,
          }
    );
  }, []);

  const clearValidationProviderError = useCallback(() => {
    if (!FREE_TIER_VALIDATION_MODE) {
      return;
    }

    setValidationStatus((current) =>
      current.lastProviderError === null
        ? current
        : {
            ...current,
            lastProviderError: null,
          }
    );
  }, []);

  useEffect(() => {
    if (!FREE_TIER_VALIDATION_MODE || !providerNotice || providerNotice.tone !== "error") {
      return;
    }

    recordValidationProviderError(providerNotice.message);
  }, [providerNotice, recordValidationProviderError]);

  useEffect(() => {
    if (!FREE_TIER_VALIDATION_MODE) {
      return;
    }

    let unlisten: UnlistenFn | null = null;

    void listen<ProviderStatusEvent>("provider://status", (event) => {
      const payload = event.payload;
      if (payload.kind === "error") {
        recordValidationProviderError(payload.message);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [recordValidationProviderError]);

  const setContextHistoryUiState = useCallback(
    (
      symbol: string,
      timeframe: Timeframe,
      status: HistoryUiState["status"],
      message: string | null,
      source?: HistoryUiSource
    ) => {
      const key = makeMarketContextKey(symbol, timeframe);

      setHistoryUiStates((current) => {
        const nextState =
          status === "idle"
            ? createIdleHistoryUiState()
            : {
                status,
                message,
                source,
              };
        const existing = current[key];

        if (
          existing?.status === nextState.status &&
          existing?.message === nextState.message &&
          existing?.source === nextState.source
        ) {
          return current;
        }

        return {
          ...current,
          [key]: nextState,
        };
      });
    },
    []
  );

  const clearContextHistoryUiState = useCallback(
    (symbol: string, timeframe: Timeframe) => {
      setContextHistoryUiState(symbol, timeframe, "idle", null);
    },
    [setContextHistoryUiState]
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

  const getRetainedCandleCount = useCallback((symbol: string, timeframe: Timeframe) => {
    return dataRef.current[symbol]?.[timeframe]?.length ?? 0;
  }, []);

  const fetchHistoricalDeduped = useCallback(
    async (
      request: HistoricalRequest & {
        force?: boolean;
      }
    ): Promise<Candle[]> => {
      const { symbol, timeframe, from, to, limit, force = false } = request;
      const loaded = getRetainedLoadedRange(symbol, timeframe);
      const retainedCount = getRetainedCandleCount(symbol, timeframe);
      const requiredOpenEndedDepth =
        from == null && to == null ? limit ?? historicalRequestLimit(timeframe) : 0;
      const hasRequestedOpenEndedDepth =
        requiredOpenEndedDepth === 0 || retainedCount >= requiredOpenEndedDepth;

      if (!force && hasRequestedOpenEndedDepth && isRangeCovered(loaded, from, to)) {
        return [];
      }

      const key = makeRangeRequestKey(
        providerMode ?? "unknown",
        symbol,
        timeframe,
        from,
        to,
        limit
      );
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
    [getRetainedCandleCount, getRetainedLoadedRange, providerMode]
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
        return { candles: [], failed: false };
      }

      const step = timeframeSeconds(timeframe);
      const limit = historicalRequestLimit(timeframe);
      const to = currentOldest - step;

      if (to <= 0) {
        return { candles: [], failed: false };
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

        return { candles, failed: false };
      } catch (error) {
        console.error(`[App] Failed to backfill ${symbol}/${timeframe}:`, error);
        return { candles: [], failed: true };
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
          failed: false,
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
            failed: false,
          };
        }

        if (createPanelContextKey(panelState.panel) !== initialPanelContext) {
          return {
            resolved: null,
            didBackfill,
            contextChanged: true,
            failed: false,
          };
        }

        const oldestLoaded =
          getRetainedLoadedRange(panelState.panel.symbol, panelState.panel.timeframe).oldest ??
          panelState.candles[0]?.time ??
          null;

        if (oldestLoaded === null || targetTimestamp >= oldestLoaded) {
          break;
        }

        const olderHistory = await loadOlderHistory(
          panelState.panel.symbol,
          panelState.panel.timeframe,
          oldestLoaded
        );
        didBackfill = true;

        if (olderHistory.failed) {
          return {
            resolved: null,
            didBackfill,
            contextChanged: false,
            failed: true,
          };
        }

        if (olderHistory.candles.length === 0) {
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
          failed: false,
        };
      }

      if (createPanelContextKey(panelState.panel) !== initialPanelContext) {
        return {
          resolved: null,
          didBackfill,
          contextChanged: true,
          failed: false,
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
          failed: false,
        };
      }

      return {
        resolved: resolveReplayPosition(panelId, targetTimestamp),
        didBackfill,
        contextChanged: false,
        failed: false,
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

      const historySource: HistoryUiSource = source === "start" ? "replay" : "jump";
      const loadingMessage =
        source === "start"
          ? "Loading older history for the replay start..."
          : "Loading older history for the jump target...";
      const emptyMessage =
        source === "start"
          ? "No earlier history is available for that replay start."
          : "No earlier history is available for that jump target.";
      const failedMessage =
        source === "start"
          ? "Could not load older history for that replay start."
          : "Could not load older history for that jump target.";
      const panelContext = createPanelContextKey(panelState.panel);
      const oldestLoaded =
        getRetainedLoadedRange(panelState.panel.symbol, panelState.panel.timeframe).oldest ??
        panelState.candles[0]?.time ??
        null;
      const needsBackfill = oldestLoaded !== null && targetTimestamp < oldestLoaded;
      const requestId = replayHistoryRequestIdRef.current + 1;

      replayHistoryRequestIdRef.current = requestId;

      if (needsBackfill) {
        setContextHistoryUiState(
          panelState.panel.symbol,
          panelState.panel.timeframe,
          "loading",
          loadingMessage,
          historySource
        );
        setReplayHistoryStatus("loading");
        setReplayHistoryMessage(loadingMessage);
      } else {
        clearContextHistoryUiState(panelState.panel.symbol, panelState.panel.timeframe);
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
        clearContextHistoryUiState(panelState.panel.symbol, panelState.panel.timeframe);
        clearReplayHistoryFeedback();
        return null;
      }

      if (!result.resolved) {
        if (needsBackfill || result.didBackfill) {
          if (result.failed) {
            setContextHistoryUiState(
              currentPanelState.panel.symbol,
              currentPanelState.panel.timeframe,
              "failed",
              failedMessage,
              historySource
            );
            setReplayHistoryStatus("failed");
            setReplayHistoryMessage(failedMessage);
          } else {
            setContextHistoryUiState(
              currentPanelState.panel.symbol,
              currentPanelState.panel.timeframe,
              "empty",
              emptyMessage,
              historySource
            );
            setReplayHistoryStatus("failed");
            setReplayHistoryMessage(emptyMessage);
          }
        } else {
          clearContextHistoryUiState(currentPanelState.panel.symbol, currentPanelState.panel.timeframe);
          clearReplayHistoryFeedback();
        }

        return null;
      }

      clearContextHistoryUiState(currentPanelState.panel.symbol, currentPanelState.panel.timeframe);
      clearReplayHistoryFeedback();
      return result.resolved;
    },
    [
      clearContextHistoryUiState,
      clearReplayHistoryFeedback,
      ensureHistoryForTimestamp,
      getReplayPanelState,
      getRetainedLoadedRange,
      setContextHistoryUiState,
    ]
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
    const anchorTimestamp =
      isReplay ? replayCursorTime ?? replayStartTime : null;
    const anchorDate =
      anchorTimestamp !== null
        ? new Date(anchorTimestamp * 1000)
        : new Date();
    const { start } = getSessionRange(anchorDate, session);
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

  useEffect(() => {
    if (!isReplay || isReplaySelectingStart || replayCursorTime === null || !activeChart) return;

    const panelState = getReplayPanelState(activeChart);
    if (!panelState || panelState.candles.length === 0) return;

    const resolvedIndex = findCandleIndexAtOrBefore(panelState.candles, replayCursorTime);
    if (resolvedIndex !== replayIndex) {
      setReplayIndex(resolvedIndex);
    }
  }, [
    activeChart,
    getReplayPanelState,
    isReplay,
    isReplaySelectingStart,
    replayCursorTime,
    replayIndex,
  ]);

  useEffect(() => {
    if (!isReplay || isReplaySelectingStart || replayStartTime === null) return;

    const replayStart = replayStartTime;
    const targetPanels = isReplaySync
      ? visiblePanels
      : layoutPanels.filter((panel) => panel.id === (activeChart ?? visiblePanels[0]?.id));

    if (targetPanels.length === 0) return;

    let cancelled = false;

    async function hydrateReplayContexts() {
      for (const panel of targetPanels) {
        const panelState = getReplayPanelState(panel.id);
        if (!panelState) {
          continue;
        }

        const oldestLoaded =
          getRetainedLoadedRange(panel.symbol, panel.timeframe).oldest ??
          panelState.candles[0]?.time ??
          null;

        if (oldestLoaded === null || replayStart >= oldestLoaded) {
          if (!isReplaySync && panel.id === activeChart && replayCursorTime !== null) {
            const resolvedCursor = resolveReplayPosition(panel.id, replayCursorTime);
            if (resolvedCursor && resolvedCursor.index !== replayIndex) {
              setReplayIndex(resolvedCursor.index);
            }
          }
          continue;
        }

        setContextHistoryUiState(
          panel.symbol,
          panel.timeframe,
          "loading",
          isReplaySync
            ? "Loading history for this synced panel..."
            : "Loading history for this replay context...",
          "context-sync"
        );

        const result = await ensureHistoryForTimestamp(panel.id, replayStart);
        if (cancelled) {
          return;
        }

        const currentPanelState = getReplayPanelState(panel.id);
        if (!currentPanelState || result.contextChanged) {
          continue;
        }

        if (result.failed) {
          setContextHistoryUiState(
            currentPanelState.panel.symbol,
            currentPanelState.panel.timeframe,
            "failed",
            "Could not load history for this replay context.",
            "context-sync"
          );
          continue;
        }

        if (!result.resolved) {
          setContextHistoryUiState(
            currentPanelState.panel.symbol,
            currentPanelState.panel.timeframe,
            "empty",
            "No earlier history is available for this replay context.",
            "context-sync"
          );
          continue;
        }

        clearContextHistoryUiState(
          currentPanelState.panel.symbol,
          currentPanelState.panel.timeframe
        );

        if (!isReplaySync && panel.id === activeChart) {
          const resolvedCursor = resolveReplayPosition(panel.id, replayCursorTime ?? replayStart);
          if (resolvedCursor) {
            setReplayIndex(resolvedCursor.index);
            setReplayCursorTime(resolvedCursor.timestamp);
          }
        }
      }
    }

    void hydrateReplayContexts();

    return () => {
      cancelled = true;
    };
  }, [
    activeChart,
    clearContextHistoryUiState,
    ensureHistoryForTimestamp,
    getReplayPanelState,
    getRetainedLoadedRange,
    isReplay,
    isReplaySelectingStart,
    isReplaySync,
    layoutPanels,
    replayCursorTime,
    replayIndex,
    replayStartTime,
    resolveReplayPosition,
    setContextHistoryUiState,
    visiblePanels,
  ]);

  // Keep dataRef in sync with state (including historical loads)
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    loadedRangesRef.current = loadedRanges;
  }, [loadedRanges]);

  useEffect(() => {
    requiredContextsRef.current = effectiveRequiredContexts;
  }, [effectiveRequiredContexts]);

  useEffect(() => {
    layoutPanelsRef.current = layoutPanels;
  }, [layoutPanels]);

  useEffect(() => {
    if (!FREE_TIER_VALIDATION_MODE) {
      return;
    }

    if (layoutType !== DEFAULT_LAYOUT_TYPE) {
      setLayoutType(DEFAULT_LAYOUT_TYPE);
    }

    const validationPanelId = layoutPanels[0]?.id ?? null;
    if (validationPanelId && activeChart !== validationPanelId) {
      setActiveChart(validationPanelId);
    }
  }, [activeChart, layoutPanels, layoutType]);

  useEffect(() => {
    activeChartRef.current = activeChart;
  }, [activeChart]);

  useEffect(() => {
    isReplayRef.current = isReplay;
  }, [isReplay]);

  useEffect(() => {
    isReplaySyncRef.current = isReplaySync;
  }, [isReplaySync]);

  useEffect(() => {
    const activeKeys = new Set<MarketContextKey>(
      effectiveRequiredContexts.map((context) => context.key)
    );

    setHistoryUiStates((current) => {
      const nextEntries = Object.entries(current).filter(([key]) =>
        activeKeys.has(key as MarketContextKey)
      );
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries) as Record<MarketContextKey, HistoryUiState>;
    });
  }, [effectiveRequiredContexts]);

  useEffect(() => {
    if (!FREE_TIER_VALIDATION_MODE) {
      return;
    }

    const blockedContexts = requiredContexts.slice(1).map((context) => context.key);
    if (blockedContexts.length > 0) {
      relayFrontendDebugLog("validation:contexts", {
        action: "blocked_extra_contexts",
        blockedContexts,
      });
    }

    const activeValidationContext = effectiveRequiredContexts[0] ?? null;
    if (activeValidationContext) {
      relayFrontendDebugLog("validation:contexts", {
        action: "active_context",
        symbol: activeValidationContext.symbol,
        timeframe: activeValidationContext.timeframe,
      });
    }
  }, [effectiveRequiredContexts, requiredContexts]);

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
    if (FREE_TIER_VALIDATION_MODE) {
      if (workspaces.length > 0) {
        relayFrontendDebugLog("validation:workspace", {
          action: "restore_skipped",
          count: workspaces.length,
        });
      } else {
        relayFrontendDebugLog("validation:workspace", {
          action: "default_workspace_skipped",
        });
      }
      return;
    }

    if (workspaces.length > 0) return;

    const defaultWorkspace = {
      id: crypto.randomUUID(),
      name: "Default",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      layoutType: "2",
      panels: DEFAULT_PANELS,
      drawingsBySymbol: Object.fromEntries(
        DEFAULT_SUPPORTED_SYMBOL_IDS.map((symbolId) => [symbolId, EMPTY_CHART_DRAWINGS])
      ),
    };

    createDefaultWorkspace(defaultWorkspace);
    setActiveWorkspace(defaultWorkspace.id);
  }, [workspaces.length, createDefaultWorkspace, setActiveWorkspace]);

  useEffect(() => {
    let cancelled = false;

    async function loadProviderCapabilities() {
      try {
        const capabilities = await marketDataProvider.getCapabilities();
        if (cancelled) {
          return;
        }

        if (capabilities.supportedSymbols.length > 0) {
          setSupportedSymbols((current) => {
            const nextSymbols = capabilities.supportedSymbols;
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

        setSupportedTimeframes((current) => {
          const sameTimeframes =
            current.length === capabilities.supportedTimeframes.length &&
            current.every((timeframe, index) => timeframe === capabilities.supportedTimeframes[index]);

          return sameTimeframes ? current : capabilities.supportedTimeframes;
        });
        setLiveSupported(capabilities.liveSupported);
        setProviderCacheReady(false);
        setProviderMode(capabilities.providerMode);
        setProviderLiveSource(capabilities.liveSource ?? null);
        setProviderPollIntervalMs(capabilities.pollIntervalMs ?? null);
        setStrictRealtime(Boolean(capabilities.strictRealtime));
        clearValidationProviderError();

        if (capabilities.notice) {
          showProviderNotice("warning", capabilities.notice);
        } else {
          clearProviderNotice((notice) => notice.tone === "warning");
        }
      } catch (error) {
        console.warn("[App] Falling back to default provider capabilities:", error);
        recordValidationProviderError(
          error instanceof Error ? error.message : String(error)
        );
        if (!cancelled) {
          setSupportedTimeframes(DEFAULT_SUPPORTED_TIMEFRAMES);
          setLiveSupported(true);
          setProviderCacheReady(true);
          setProviderLiveSource(null);
          setProviderPollIntervalMs(null);
          setStrictRealtime(false);
          showProviderNotice("warning", "Using default provider capabilities while backend settings load.");
        }
      }
    }

    void loadProviderCapabilities();

    return () => {
      cancelled = true;
    };
  }, [
    clearProviderNotice,
    clearValidationProviderError,
    recordValidationProviderError,
    showProviderNotice,
  ]);

  useEffect(() => {
    if (!providerMode) {
      return;
    }

    const cachedData = readStoredData(providerMode);
    const nextRanges = createLoadedRangesFromData(cachedData);

    inFlightHistoricalRequestsRef.current.clear();
    dataRef.current = cachedData;
    loadedRangesRef.current = nextRanges;
    setData(cachedData);
    setLoadedRanges(nextRanges);
    loadCandleDataFromCache(providerMode);
    setProviderCacheReady(true);
  }, [loadCandleDataFromCache, providerMode]);

  // Persist chart data to localStorage on every change
  useEffect(() => {
    if (!providerMode || !providerCacheReady) {
      return;
    }

    try {
      persistScopedCandleCache(
        window.localStorage,
        DATA_STORAGE_KEY,
        LEGACY_DATA_STORAGE_KEYS,
        providerMode,
        data
      );
    } catch (error) {
      console.error("[App] Failed to cache chart data:", error);
    }
  }, [data, providerCacheReady, providerMode]);

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
      if (!providerCacheReady) {
        return;
      }

      for (const context of effectiveRequiredContexts) {
        try {
          const request = buildInitialHistoricalRequest(context.symbol, context.timeframe);
          const alreadyCovered = isRangeCovered(
            getRetainedLoadedRange(context.symbol, context.timeframe),
            request.from,
            request.to
          );

          if (alreadyCovered) {
            clearContextHistoryUiState(context.symbol, context.timeframe);
            continue;
          }

          setContextHistoryUiState(
            context.symbol,
            context.timeframe,
            "loading",
            "Loading history for this panel...",
            "initial"
          );

          const candles = await fetchHistoricalDeduped(request);

          if (cancelled || candles.length === 0) {
            const retainedCandles = dataRef.current[context.symbol]?.[context.timeframe] ?? [];
            if (!cancelled) {
              if (retainedCandles.length > 0) {
                clearContextHistoryUiState(context.symbol, context.timeframe);
              } else {
                setContextHistoryUiState(
                  context.symbol,
                  context.timeframe,
                  "empty",
                  "No history is available for this panel yet.",
                  "initial"
                );
              }
            }
            continue;
          }

          applyHistoricalCandles(context.symbol, context.timeframe, candles);
          clearContextHistoryUiState(context.symbol, context.timeframe);
        } catch (error) {
          historicalLoadFailed = true;
          recordValidationProviderError(error instanceof Error ? error.message : String(error));
          if (!cancelled) {
            setContextHistoryUiState(
              context.symbol,
              context.timeframe,
              "failed",
              "Could not load history for this panel.",
              "initial"
            );
          }
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
    clearContextHistoryUiState,
    clearProviderNotice,
    effectiveRequiredContexts,
    fetchHistoricalDeduped,
    getRetainedLoadedRange,
    providerCacheReady,
    recordValidationProviderError,
    setContextHistoryUiState,
    showProviderNotice,
  ]);

  useEffect(() => {
    let cancelled = false;
    let subscriptionFailed = false;

    async function syncDemandDrivenSubscriptions() {
      if (!providerCacheReady) {
        return;
      }

      const currentSubscriptions = liveSubscriptionsRef.current;

      if (!liveSupported) {
        for (const [key, subscription] of Array.from(currentSubscriptions.entries())) {
          try {
            await subscription.unsubscribe();
            currentSubscriptions.delete(key);
          } catch (error) {
            console.error(`[App] Live unsubscribe error for ${key}:`, error);
          }
        }

        if (!cancelled) {
          clearProviderNotice(
            (notice) => notice.message === "Live data subscription failed for one or more streams."
          );
        }

        return;
      }

      const nextContexts = new Set(effectiveRequiredContexts.map((context) => context.key));
      const pendingSubscriptions = pendingLiveSubscriptionsRef.current;

      for (const [key, subscription] of Array.from(currentSubscriptions.entries())) {
        if (nextContexts.has(key)) {
          continue;
        }

        try {
          if (FREE_TIER_VALIDATION_MODE) {
            relayFrontendDebugLog("validation:live", {
              action: "unsubscribe_prior_poll",
              key,
            });
          }
          await subscription.unsubscribe();
          currentSubscriptions.delete(key);
        } catch (error) {
          subscriptionFailed = true;
          recordValidationProviderError(error instanceof Error ? error.message : String(error));
          console.error(`[App] Live unsubscribe error for ${key}:`, error);
        }
      }

      for (const context of effectiveRequiredContexts) {
        if (currentSubscriptions.has(context.key) || pendingSubscriptions.has(context.key)) {
          continue;
        }

        pendingSubscriptions.add(context.key);

        try {
          const subscription = await marketDataProvider.subscribeLive(
            context.symbol,
            context.timeframe,
            (incoming) => {
              if (FREE_TIER_VALIDATION_MODE) {
                setValidationStatus((current) => ({
                  ...current,
                  lastLiveEventTime: incoming.time,
                }));
              }

              if (cancelled || !shouldApplyLiveUpdate(context.symbol, context.timeframe)) return;

              setData((prev) => {
                const currentSymbolData = prev[context.symbol] ?? createEmptyTimeframeData();
                const merge = mergeLiveCandleSeries(
                  currentSymbolData[context.timeframe] ?? [],
                  incoming,
                  context.timeframe
                );

                if (DEBUG_LIVE_UPDATES) {
                  console.debug("[live:merge]", {
                    symbol: context.symbol,
                    timeframe: context.timeframe,
                    time: incoming.time,
                    close: incoming.close,
                    action: merge.action,
                  });
                  relayFrontendDebugLog("live:merge", {
                    symbol: context.symbol,
                    timeframe: context.timeframe,
                    time: incoming.time,
                    close: incoming.close,
                    action: merge.action,
                  });
                }

                if (merge.action === "ignore") {
                  return prev;
                }

                if (FREE_TIER_VALIDATION_MODE) {
                  setValidationStatus((current) => ({
                    ...current,
                    lastMergeTime: incoming.time,
                  }));
                }

                const nextState = {
                  ...prev,
                  [context.symbol]: {
                    ...currentSymbolData,
                    [context.timeframe]: merge.candles,
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
              recordValidationProviderError(error instanceof Error ? error.message : String(error));
              currentSubscriptions.set(context.key, subscription);
              console.error(`[App] Live unsubscribe error for ${context.key}:`, error);
            }
            continue;
          }

          currentSubscriptions.set(context.key, subscription);
          clearValidationProviderError();
        } catch (error) {
          subscriptionFailed = true;
          recordValidationProviderError(error instanceof Error ? error.message : String(error));
          console.error(`[App] Live subscription error for ${context.key}:`, error);
        } finally {
          pendingSubscriptions.delete(context.key);
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
  }, [
    clearProviderNotice,
    clearValidationProviderError,
    effectiveRequiredContexts,
    liveSupported,
    providerCacheReady,
    recordValidationProviderError,
    shouldApplyLiveUpdate,
    showProviderNotice,
  ]);

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

  const validationActiveContext = FREE_TIER_VALIDATION_MODE
    ? effectiveRequiredContexts[0] ?? layoutPanels[0] ?? null
    : null;

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
          showSessionLevels={showSessionLevels}
          setShowSessionLevels={setShowSessionLevels}
          showSessionRanges={showSessionRanges}
          setShowSessionRanges={setShowSessionRanges}
          showSma={showSma}
          setShowSma={setShowSma}
          smaPeriod={smaPeriod}
          setSmaPeriod={(period) => setSmaPeriod(sanitizeIndicatorPeriod(period))}
          jumpToSession={jumpToSession}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undoDrawings}
          onRedo={redoDrawings}
        />
      </div>

      <div style={{ display: "flex", height: "100%" }}>
        <Sidebar />

        <div className="app-shell__viewport" style={{ position: "relative", flex: 1 }}>
          {FREE_TIER_VALIDATION_MODE && DEBUG_LIVE_UPDATES && (
            <div
              style={{
                position: "absolute",
                top: "12px",
                right: "12px",
                zIndex: 20,
                minWidth: "260px",
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid rgba(59, 130, 246, 0.25)",
                background: "rgba(15, 23, 42, 0.92)",
                color: "#dbeafe",
                fontSize: "12px",
                lineHeight: 1.5,
                boxShadow: "0 16px 40px rgba(15, 23, 42, 0.32)",
              }}
            >
              <div style={{ fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Validation Mode
              </div>
              <div>
                {validationActiveContext?.symbol?.toUpperCase() ?? "EURUSD"}{" "}
                {validationActiveContext?.timeframe ?? "1m"}
              </div>
              <div>Provider: {providerMode ?? "loading"}</div>
              <div>Live: {providerLiveSource ?? "real_poll"}</div>
              <div>Poll: {providerPollIntervalMs ?? 15_000}ms</div>
              <div>Strict: {strictRealtime ? "on" : "off"}</div>
              <div>
                Last event: {formatValidationTimestamp(validationStatus.lastLiveEventTime)}
              </div>
              <div>
                Last merge: {formatValidationTimestamp(validationStatus.lastMergeTime)}
              </div>
              <div
                style={{
                  marginTop: "4px",
                  color: validationStatus.lastProviderError ? "#fca5a5" : "#93c5fd",
                }}
              >
                Error: {validationStatus.lastProviderError ?? "none"}
              </div>
            </div>
          )}
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
            supportedTimeframes={supportedTimeframes}
            showSessions={showSessions}
            showSessionLevels={showSessionLevels}
            showSessionRanges={showSessionRanges}
            showSma={showSma}
            smaPeriod={smaPeriod}
            historyUiStates={historyUiStates}
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
