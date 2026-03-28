import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import TopBar from "./components/TopBar";
import LayoutManager from "./layout/LayoutManager";
import Sidebar from "./components/SideBar";
import ErrorBoundary from "./components/ErrorBoundary";
import { useToolStore } from "./store/useToolStore";

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

function AppInner() {
  const [data, setData] = useState(() => readStoredData());
  const dataRef = useRef(data);

  const [crosshairTime, setCrosshairTime] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<any>(null);
  const [rangeSource, setRangeSource] = useState<string | null>(null);
  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [layoutType, setLayoutType] = useState("2");

  const tool = useToolStore((state) => state.tool);

  useEffect(() => {
    try {
      window.localStorage.setItem(DATA_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error("[App] Failed to cache chart data:", error);
    }
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    function updateSymbol(symbol: string, tf: Timeframe, candle: Candle) {
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
  }, []);

  return (
    <div className="app-shell">
      <div className="app-shell__toolbar">
        <TopBar layoutType={layoutType} setLayoutType={setLayoutType} />
      </div>

      <div style={{ display: "flex", height: "100%" }}>
        <Sidebar />

        <div className="app-shell__viewport" style={{ flex: 1 }}>
          <LayoutManager
            data={data}
            layoutType={layoutType}
            activeChart={activeChart}
            setActiveChart={setActiveChart}
            crosshairTime={crosshairTime}
            setCrosshairTime={setCrosshairTime}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            rangeSource={rangeSource}
            setRangeSource={setRangeSource}
            tool={tool}
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
