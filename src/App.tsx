import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import LayoutManager from "./layout/LayoutManager";

type Candle = {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type DataState = {
  nq: Candle[];
  es: Candle[];
};

function App() {
  const [data, setData] = useState<DataState>({ nq: [], es: [] });
  const dataRef = useRef<DataState>({ nq: [], es: [] });
  const started = useRef(false);
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<any>(null);
  const [activeChart, setActiveChart] = useState<string | null>(null);

  useEffect(() => {
    function updateSymbol(symbol: "nq" | "es", candle: Candle, isNew: boolean) {
      const current = dataRef.current[symbol];
      let updated: Candle[];
      if (isNew) {
        updated = [...current, candle];
      } else {
        if (current.length === 0) return;
        updated = [...current];
        updated[updated.length - 1] = candle;
      }
      const newState = { ...dataRef.current, [symbol]: updated };
      dataRef.current = newState;
      setData(newState);
    }

    const listeners = [
      listen<Candle>("candle_live_nq", (e) => updateSymbol("nq", e.payload, false)),
      listen<Candle>("candle_new_nq",  (e) => updateSymbol("nq", e.payload, true)),
      listen<Candle>("candle_live_es", (e) => updateSymbol("es", e.payload, false)),
      listen<Candle>("candle_new_es",  (e) => updateSymbol("es", e.payload, true)),
    ];

    if (!started.current) {
      started.current = true;
      invoke("start_all_streams").catch((err) =>
        console.error("Invoke error:", err)
      );
    }

    return () => {
      listeners.forEach((l) => l.then((f) => f()));
    };
  }, []);

  return (
    <div style={{ background: "#0e0e11", height: "100vh", overflow: "hidden" }}>
      <LayoutManager
        data={data}
        activeChart={activeChart}
        setActiveChart={setActiveChart}
        crosshairTime={crosshairTime}
        setCrosshairTime={setCrosshairTime}
        timeRange={timeRange}
        setTimeRange={setTimeRange}
      />
    </div>
  );
}

export default App;