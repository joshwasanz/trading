import { useCallback, useEffect, useState } from "react";
import ChartPanel from "./ChartPanel";
import {
  EMPTY_CHART_DRAWINGS,
  type ChartDrawings,
  type DrawingsState,
  type Rectangle,
  type Trendline,
} from "../types/drawings";

type Timeframe = "15s" | "1m" | "3m";

type Panel = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
};

const DEFAULT_PANELS: Panel[] = [
  { id: "A", symbol: "nq", timeframe: "15s" },
  { id: "B", symbol: "es", timeframe: "15s" },
  { id: "C", symbol: "dxy", timeframe: "15s" },
  { id: "D", symbol: "nq", timeframe: "1m" },
  { id: "E", symbol: "es", timeframe: "1m" },
  { id: "F", symbol: "dxy", timeframe: "1m" },
];

const DRAWINGS_STORAGE_KEY = "layout-manager-drawings-v1";

function readStoredDrawings(): DrawingsState {
  if (typeof window === "undefined") return {};

  try {
    const stored = window.localStorage.getItem(DRAWINGS_STORAGE_KEY);
    if (!stored) return {};

    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as DrawingsState;
  } catch (error) {
    console.error("[LayoutManager] Failed to read drawings:", error);
    return {};
  }
}

export default function LayoutManager({
  data,
  layoutType,
  activeChart,
  setActiveChart,
  setCrosshairTime,
  timeRange,
  setTimeRange,
  rangeSource,
  setRangeSource,
  tool,
}: any) {
  const [vSplit, setVSplit] = useState(0.5);
  const [hSplit, setHSplit] = useState(0.5);
  const [panels, setPanels] = useState<Panel[]>(DEFAULT_PANELS);
  const [focused, setFocused] = useState<string | null>(null);
  const [drawingsByChart, setDrawingsByChart] = useState<DrawingsState>(() => readStoredDrawings());

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(drawingsByChart));
    } catch (error) {
      console.error("[LayoutManager] Failed to save drawings:", error);
    }
  }, [drawingsByChart]);

  const sharedProps = {
    activeChart,
    setActiveChart,
    onCrosshairMove: (time: number) => setCrosshairTime(time),
    onTimeRangeChange: (range: any, sourceChartId: string) => {
      setTimeRange(range);
      setRangeSource(sourceChartId);
    },
    externalRange: timeRange,
    rangeSource,
    tool,
  };

  const updatePanel = useCallback((id: string, updates: Partial<Panel>) => {
    setPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, ...updates } : panel)));
  }, []);

  const getPanel = useCallback((id: string) => panels.find((panel) => panel.id === id)!, [panels]);

  const getChartDrawings = useCallback(
    (chartId: string): ChartDrawings => drawingsByChart[chartId] ?? EMPTY_CHART_DRAWINGS,
    [drawingsByChart]
  );

  const updateChartDrawings = useCallback(
    (chartId: string, updater: (current: ChartDrawings) => ChartDrawings) => {
      setDrawingsByChart((prev) => {
        const current = prev[chartId] ?? EMPTY_CHART_DRAWINGS;
        return {
          ...prev,
          [chartId]: updater(current),
        };
      });
    },
    []
  );

  const handleAddTrendline = useCallback(
    (chartId: string, line: Trendline) => {
      updateChartDrawings(chartId, (current) => ({
        trendlines: [...current.trendlines, line],
        rectangles: current.rectangles,
      }));
    },
    [updateChartDrawings]
  );

  const handleAddRectangle = useCallback(
    (chartId: string, rect: Rectangle) => {
      updateChartDrawings(chartId, (current) => ({
        trendlines: current.trendlines,
        rectangles: [...current.rectangles, rect],
      }));
    },
    [updateChartDrawings]
  );

  const renderPanel = (panel: Panel, onFocus: () => void) => (
    <ChartPanel
      panelId={panel.id}
      symbol={panel.symbol}
      timeframe={panel.timeframe}
      data={data[panel.symbol]?.[panel.timeframe] || []}
      drawings={getChartDrawings(panel.id)}
      onAddTrendline={handleAddTrendline}
      onAddRectangle={handleAddRectangle}
      onFocus={onFocus}
      onSymbolChange={(symbol) => updatePanel(panel.id, { symbol })}
      onTimeframeChange={(timeframe) => updatePanel(panel.id, { timeframe })}
      {...sharedProps}
    />
  );

  const startVerticalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setVSplit(Math.max(0.2, Math.min(0.8, ev.clientX / window.innerWidth)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startHorizontalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setHSplit(Math.max(0.2, Math.min(0.8, ev.clientY / window.innerHeight)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (focused) {
    const panel = getPanel(focused);
    return (
      <div className="focus-mode">
        <div className="focus-mode__header">
          <button onClick={() => setFocused(null)}>← Back</button>
        </div>
        <div className="focus-mode__content">{renderPanel(panel, () => setFocused(null))}</div>
      </div>
    );
  }

  if (layoutType === "2") {
    const [p0, p1] = panels;
    return (
      <div className="layout-engine">
        <div style={{ position: "absolute", left: 0, top: 0, width: `${vSplit * 100}%`, height: "100%" }}>
          {renderPanel(p0, () => setFocused(p0.id))}
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: `${(1 - vSplit) * 100}%`, height: "100%" }}>
          {renderPanel(p1, () => setFocused(p1.id))}
        </div>

        <div
          onMouseDown={startVerticalResize}
          style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: "6px", height: "100%", cursor: "col-resize", zIndex: 50, transform: "translateX(-3px)" }}
        />
      </div>
    );
  }

  if (layoutType === "3") {
    const [p0, p1, p2] = panels;
    return (
      <div className="layout-engine">
        <div style={{ position: "absolute", left: 0, top: 0, width: `${vSplit * 100}%`, height: "100%" }}>
          {renderPanel(p0, () => setFocused(p0.id))}
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: `${(1 - vSplit) * 100}%`, height: `${hSplit * 100}%` }}>
          {renderPanel(p1, () => setFocused(p1.id))}
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: `${hSplit * 100}%`, width: `${(1 - vSplit) * 100}%`, height: `${(1 - hSplit) * 100}%` }}>
          {renderPanel(p2, () => setFocused(p2.id))}
        </div>

        <div onMouseDown={startVerticalResize} style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: "6px", height: "100%", cursor: "col-resize", transform: "translateX(-3px)", zIndex: 50 }} />
        <div onMouseDown={startHorizontalResize} style={{ position: "absolute", left: `${vSplit * 100}%`, top: `${hSplit * 100}%`, width: `${(1 - vSplit) * 100}%`, height: "6px", cursor: "row-resize", transform: "translateY(-3px)", zIndex: 50 }} />
      </div>
    );
  }

  if (layoutType === "6") {
    return (
      <div className="layout-engine">
        {panels.map((panel, i) => (
          <div
            key={panel.id}
            style={{
              position: "absolute",
              left: `${(i % 3) * 33.33}%`,
              top: i < 3 ? "0%" : "50%",
              width: "33.33%",
              height: "50%",
            }}
          >
            {renderPanel(panel, () => setFocused(panel.id))}
          </div>
        ))}
      </div>
    );
  }

  return null;
}
