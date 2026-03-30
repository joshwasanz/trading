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
import type { Candle, SupportedSymbol, Timeframe } from "./types/marketData";
import type { ReplayStartPayload } from "./types/replay";
import { getSessionRange, type SessionKey } from "./types/sessions";
import { findCandleIndexAtOrBefore } from "./utils/replay";

const DATA_STORAGE_KEY = "chart-data-v1";
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
    const stored = window.localStorage.getItem(DATA_STORAGE_KEY);
    if (!stored) return initialDataState;

    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return initialDataState;
    }

    const merged: Record<string, Record<Timeframe, Candle[]>> = {
      nq: createEmptyTimeframeData(),
      es: createEmptyTimeframeData(),
    };

    for (const [symbol, maybeSeries] of Object.entries(parsed as Record<string, unknown>)) {
      const series = maybeSeries as Partial<Record<Timeframe, Candle[]>>;
      const current = merged[symbol] ?? createEmptyTimeframeData();

      merged[symbol] = {
        "15s": Array.isArray(series["15s"]) ? series["15s"] : current["15s"],
        "1m": Array.isArray(series["1m"]) ? series["1m"] : current["1m"],
        "3m": Array.isArray(series["3m"]) ? series["3m"] : current["3m"],
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
        candles: data[panel.symbol]?.[panel.timeframe] ?? [],
      };
    },
    [data, panels]
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

  // Jump to specific time: find candle by UNIX timestamp and move replay index
  const goToTime = (targetTime: number) => {
    if (!activeChart) return;

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
  };

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
      const historicalEntries: Array<{
        symbol: string;
        timeframe: Timeframe;
        candles: Candle[];
      }> = [];

      for (const { id: symbol } of supportedSymbols) {
        for (const timeframe of SUPPORTED_TIMEFRAMES) {
          try {
            const candles = await marketDataProvider.getHistorical({
              symbol,
              timeframe,
            });

            if (cancelled) {
              return;
            }

            historicalEntries.push({ symbol, timeframe, candles });
            setCandleData(symbol, timeframe, candles);
          } catch (error) {
            console.error(`[App] Failed to load ${symbol}/${timeframe}:`, error);
          }
        }
      }

      if (cancelled || historicalEntries.length === 0) {
        return;
      }

      setData((prev) => {
        let nextState = prev;

        for (const entry of historicalEntries) {
          if (entry.candles.length === 0) continue;

          const currentSymbolData = nextState[entry.symbol] ?? createEmptyTimeframeData();
          const merged = mergeHistoricalSeries(
            currentSymbolData[entry.timeframe] ?? [],
            entry.candles
          );

          nextState = {
            ...nextState,
            [entry.symbol]: {
              ...currentSymbolData,
              [entry.timeframe]: merged,
            },
          };
        }

        dataRef.current = nextState;
        return nextState;
      });
    }

    void loadHistoricalData();

    return () => {
      cancelled = true;
    };
  }, [setCandleData, supportedSymbols]);

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
