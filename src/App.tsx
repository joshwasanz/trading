import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import TopBar from "./components/TopBar";
import LayoutManager from "./layout/LayoutManager";
import Sidebar from "./components/SideBar";
import ErrorBoundary from "./components/ErrorBoundary";
import { useToolStore } from "./store/useToolStore";
import { useThemeStore } from "./store/useThemeStore";
import { useWorkspaceStore } from "./store/useWorkspaceStore";
import { useCandleStore } from "./store/useCandleStore";
import { EMPTY_CHART_DRAWINGS } from "./types/drawings";

type Candle = {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Timeframe = "15s" | "1m" | "3m";

const DATA_STORAGE_KEY = "chart-data-v1";

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

let startStreamsPromise: Promise<void> | null = null;

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

// ─── Historical Loader ────────────────────────────────────────────────────────

async function loadHistorical(
  symbol: string,
  tf: Timeframe,
  setData: React.Dispatch<React.SetStateAction<typeof initialDataState>>
) {
  try {
    const candles = await invoke<Candle[]>("get_historical", {
      symbol,
      timeframe: tf,
    });

    if (!candles || candles.length === 0) return;

    setData((prev) => {
      const existing = prev[symbol]?.[tf] ?? [];

      // Historical candles form the base — live candles sit on top
      const merged = [...candles];

      for (const live of existing) {
        const idx = merged.findIndex((c) => c.time === live.time);
        if (idx !== -1) {
          merged[idx] = live; // live overwrites the same candle
        } else if (live.time > merged[merged.length - 1].time) {
          merged.push(live); // newer live candles append to the end
        }
      }

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

// ─────────────────────────────────────────────────────────────────────────────

function AppInner() {
  const [data, setData] = useState(() => readStoredData());
  const dataRef = useRef(data);

  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [layoutType, setLayoutType] = useState("2");
  
  // Replay engine state
  const [isReplay, setIsReplay] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);

  const tool = useToolStore((state) => state.tool);
  const magnet = useToolStore((state) => state.magnet);
  const { theme } = useThemeStore();
  const { workspaces, setActiveWorkspace, createDefaultWorkspace } = useWorkspaceStore();
  const { setData: setCandleData } = useCandleStore();

  // Helper: get maximum data length across all symbol/timeframe combos
  const getMaxDataLength = () => {
    let max = 0;
    const symbols = ["nq", "es"];
    const timeframes = ["15s", "1m", "3m"] as const;
    
    for (const symbol of symbols) {
      for (const tf of timeframes) {
        const length = data[symbol]?.[tf]?.length ?? 0;
        max = Math.max(max, length);
      }
    }
    return max;
  };

  // Replay engine control functions
  const stepForward = () => {
    const maxLength = getMaxDataLength();
    setReplayIndex((i) => Math.min(i + 1, Math.max(0, maxLength - 1)));
  };

  const stepBackward = () => {
    setReplayIndex((i) => Math.max(0, i - 1));
  };

  const resetReplay = () => {
    const maxLength = getMaxDataLength();
    setReplayIndex(Math.min(100, Math.max(0, maxLength - 1)));
  };

  // When entering replay mode, jump to last candle (pause at current market state)
  useEffect(() => {
    if (isReplay) {
      const maxLength = getMaxDataLength();
      setReplayIndex(Math.max(0, maxLength - 1)); // freeze at last available candle
    }
  }, [isReplay]);

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

  // Load historical candles on startup
  useEffect(() => {
    const symbols = ["nq", "es"];
    const timeframes = ["15s", "1m", "3m"];

    async function loadHistorical() {
      for (const symbol of symbols) {
        for (const tf of timeframes) {
          try {
            const candles = await invoke<any[]>("get_historical", {
              symbol,
              timeframe: tf,
            });
            setCandleData(symbol, tf, candles);
          } catch (error) {
            console.error(`[App] Failed to load ${symbol}/${tf}:`, error);
          }
        }
      }
    }

    loadHistorical();
  }, [setCandleData]);

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

  // Load historical data on mount for all symbol/timeframe combos
  useEffect(() => {
    const symbols = ["nq", "es"];
    const timeframes: Timeframe[] = ["15s", "1m", "3m"];

    for (const symbol of symbols) {
      for (const tf of timeframes) {
        loadHistorical(symbol, tf, setData);
      }
    }
  }, []);

  // Register live stream listeners
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    function updateSymbol(symbol: string, tf: Timeframe, candle: Candle) {
      // Skip live updates when replaying historical data
      if (isReplay) return;

      const current = dataRef.current[symbol][tf] || [];
      const updated = upsertCandleSeries(current, candle);

      const nextState = {
        ...dataRef.current,
        [symbol]: {
          ...dataRef.current[symbol],
          [tf]: updated,
        },
      };

      dataRef.current = nextState;
      setData(nextState);
    }

    async function register(symbol: string, tf: Timeframe) {
      const liveEvent = `candle_live_${tf}_${symbol}`;
      const newEvent = `candle_new_${tf}_${symbol}`;

      const unlistenLive = await listen<Candle>(liveEvent, (event) => {
        if (!cancelled) updateSymbol(symbol, tf, event.payload);
      });

      const unlistenNew = await listen<Candle>(newEvent, (event) => {
        if (!cancelled) updateSymbol(symbol, tf, event.payload);
      });

      unlisteners.push(unlistenLive, unlistenNew);
    }

    async function setup() {
      try {
        const symbols = ["nq", "es"];
        const timeframes: Timeframe[] = ["15s", "1m", "3m"];

        for (const symbol of symbols) {
          for (const timeframe of timeframes) {
            await register(symbol, timeframe);
          }
        }

        if (!startStreamsPromise) {
          startStreamsPromise = invoke("start_all_streams") as Promise<void>;
        }

        await startStreamsPromise;
      } catch (error) {
        console.error("Stream init error:", error);
      }
    }

    setup();

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [isReplay]);

  return (
    <div className="app-shell">
      <div className="app-shell__toolbar">
        <TopBar
          layoutType={layoutType}
          setLayoutType={setLayoutType}
          isReplay={isReplay}
          setIsReplay={setIsReplay}
          replayIndex={replayIndex}
          stepForward={stepForward}
          stepBackward={stepBackward}
          resetReplay={resetReplay}
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
            replayIndex={replayIndex}
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