import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import TopBar from "./components/TopBar";
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
  [key: string]: Candle[];
};

const initialDataState: DataState = {
  nq: [],
  es: [],
  dax: [],
  dxy: [],
  us10y: [],
  gold: [],
};

let startStreamsPromise: Promise<void> | null = null;

function App() {
  const [data, setData] = useState<DataState>(initialDataState);
  const dataRef = useRef<DataState>(initialDataState);
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<any>(null);
  const [activeChart, setActiveChart] = useState<string | null>(null);
  const [layoutType, setLayoutType] = useState("2");

  useEffect(() => {
    function updateSymbol(symbol: string, candle: Candle, isNew: boolean) {
      const current = dataRef.current[symbol] || [];
      let updated: Candle[];

      if (isNew) {
        updated = [...current, candle];
      } else if (current.length === 0) {
        updated = [candle];
      } else {
        updated = [...current];
        updated[updated.length - 1] = candle;
      }

      const newState = { ...dataRef.current, [symbol]: updated };
      dataRef.current = newState;
      setData(newState);
    }

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    async function registerListener(
      eventName: string,
      symbol: string,
      isNew: boolean
    ) {
      console.log(`Installing: ${eventName}`);

      const unlisten = await listen<Candle>(eventName, (event) => {
        if (!cancelled) {
          updateSymbol(symbol, event.payload, isNew);
        }
      });

      if (cancelled) {
        unlisten();
        return;
      }

      unlisteners.push(unlisten);
    }

    async function setupListenersAndStart() {
      try {
        console.log("Setting up listeners...");

        await registerListener("candle_live_nq", "nq", false);
        await registerListener("candle_new_nq", "nq", true);
        await registerListener("candle_live_es", "es", false);
        await registerListener("candle_new_es", "es", true);

        if (cancelled) return;

        console.log("All listeners setup complete");

        if (!startStreamsPromise) {
          console.log("Invoking start_all_streams...");
          startStreamsPromise = invoke("start_all_streams")
            .then(() => {
              console.log("start_all_streams invoked successfully");
            })
            .catch((error) => {
              startStreamsPromise = null;
              throw error;
            });
        } else {
          console.log("start_all_streams already requested");
        }

        await startStreamsPromise;
      } catch (error) {
        console.error("Error during setup:", error);
      }
    }

    setupListenersAndStart();

    return () => {
      cancelled = true;

      for (const unlisten of unlisteners) {
        try {
          unlisten();
        } catch (error) {
          console.debug("Unlisten error:", error);
        }
      }
    };
  }, []);

  return (
    <div style={{ background: "#0e0e11", height: "100vh", display: "flex", flexDirection: "column", width: "100%" }}>
      <TopBar layoutType={layoutType} setLayoutType={setLayoutType} />

      <div style={{ flex: 1, overflow: "hidden", width: "100%" }}>
        <LayoutManager
          data={data}
          layoutType={layoutType}
          activeChart={activeChart}
          setActiveChart={setActiveChart}
          crosshairTime={crosshairTime}
          setCrosshairTime={setCrosshairTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </div>
    </div>
  );
}

export default App;
