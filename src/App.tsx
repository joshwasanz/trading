import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import TopBar from "./components/TopBar";
import LayoutManager from "./layout/LayoutManager";
import Sidebar from "./components/SideBar";
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

// 🔥 INITIAL DATA PER SYMBOL + TF
const initialDataState: Record<string, Record<Timeframe, Candle[]>> = {
  nq: { "15s": [], "1m": [], "3m": [] },
  es: { "15s": [], "1m": [], "3m": [] },
};

let startStreamsPromise: Promise<void> | null = null;

// ==================== UPSERT ====================
function upsertCandleSeries(current: Candle[], incoming: Candle): Candle[] {
  const MAX = 500; // 🔥 prevent memory bloat

  if (current.length === 0) return [incoming];

  const next = [...current];
  const lastIndex = next.length - 1;
  const last = next[lastIndex];

  if (incoming.time > last.time) {
    next.push(incoming);
  } else if (incoming.time === last.time) {
    next[lastIndex] = incoming;
  }

  // 🔥 LIMIT SIZE
  if (next.length > MAX) {
    next.splice(0, next.length - MAX);
  }

  return next;
}

// ==================== APP ====================
function App() {
  const [data, setData] = useState(initialDataState);
  const dataRef = useRef(initialDataState);

  const [crosshairTime, setCrosshairTime] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<any>(null);
  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [layoutType, setLayoutType] = useState("2");

  // 🔥 TOOL ENGINE
  const { tool } = useToolStore();

  // ==================== STREAM SETUP ====================
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
        const tfs: Timeframe[] = ["15s", "1m", "3m"];

        for (const s of symbols) {
          for (const tf of tfs) {
            await register(s, tf);
          }
        }

        if (!startStreamsPromise) {
          startStreamsPromise = invoke("start_all_streams") as Promise<void>;
        }

        await startStreamsPromise;
      } catch (err) {
        console.error("Stream init error:", err);
      }
    }

    setup();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // ==================== UI ====================
  return (
    <div className="app-shell">

      {/* 🔥 TOOLBAR */}
      <div className="app-shell__toolbar">
        <TopBar
          layoutType={layoutType}
          setLayoutType={setLayoutType}
        />
      </div>

      {/* 🔥 MAIN AREA (SIDEBAR + CHARTS) */}
      <div style={{ display: "flex", height: "100%" }}>

        {/* 🔥 SIDEBAR */}
        <Sidebar />

        {/* 🔥 CHART AREA */}
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
            tool={tool} // 🔥 CRITICAL
          />
        </div>

      </div>
    </div>
  );
}

export default App;