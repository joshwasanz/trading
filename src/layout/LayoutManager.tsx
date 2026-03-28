import { useCallback, useEffect, useState } from "react";
import ChartPanel from "./ChartPanel";
import {
  DEFAULT_TRENDLINE_EXTENSION,
  EMPTY_CHART_DRAWINGS,
  type ChartDrawings,
  type DrawingSelection,
  type DrawingsState,
  type LineExtension,
  type Point,
  type Rectangle,
  type Trendline,
  createDrawingId,
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

const DRAWINGS_STORAGE_KEY = "layout-manager-drawings-v2";
const LEGACY_DRAWINGS_STORAGE_KEY = "layout-manager-drawings-v1";
const DEFAULT_PANEL_SYMBOL_BY_ID = Object.fromEntries(
  DEFAULT_PANELS.map((panel) => [panel.id, panel.symbol])
) as Record<string, string>;

function normalizePoint(value: unknown): Point | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const maybePoint = value as { time?: unknown; price?: unknown };
  if (typeof maybePoint.time !== "number" || typeof maybePoint.price !== "number") {
    return null;
  }

  return {
    time: maybePoint.time as Point["time"],
    price: maybePoint.price,
  };
}

function normalizeTrendline(value: unknown): Trendline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const maybeLine = value as {
    id?: unknown;
    start?: unknown;
    end?: unknown;
    extend?: unknown;
  };
  const start = normalizePoint(maybeLine.start);
  const end = normalizePoint(maybeLine.end);
  if (!start || !end) return null;

  const extend: LineExtension =
    maybeLine.extend === "none" ||
    maybeLine.extend === "right" ||
    maybeLine.extend === "both"
      ? maybeLine.extend
      : DEFAULT_TRENDLINE_EXTENSION;

  return {
    id: typeof maybeLine.id === "string" ? maybeLine.id : createDrawingId("trendline"),
    start,
    end,
    extend,
  };
}

function normalizeRectangle(value: unknown): Rectangle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const maybeRect = value as { id?: unknown; start?: unknown; end?: unknown };
  const start = normalizePoint(maybeRect.start);
  const end = normalizePoint(maybeRect.end);
  if (!start || !end) return null;

  return {
    id: typeof maybeRect.id === "string" ? maybeRect.id : createDrawingId("rectangle"),
    start,
    end,
  };
}

function normalizeChartDrawings(value: unknown): ChartDrawings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_CHART_DRAWINGS;
  }

  const maybeDrawings = value as { trendlines?: unknown; rectangles?: unknown };
  return {
    trendlines: Array.isArray(maybeDrawings.trendlines)
      ? maybeDrawings.trendlines.map(normalizeTrendline).filter((line): line is Trendline => line !== null)
      : [],
    rectangles: Array.isArray(maybeDrawings.rectangles)
      ? maybeDrawings.rectangles.map(normalizeRectangle).filter((rect): rect is Rectangle => rect !== null)
      : [],
  };
}

function normalizeDrawingsState(value: unknown): DrawingsState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, chartDrawings]) => [
      key,
      normalizeChartDrawings(chartDrawings),
    ])
  );
}

function mergeUniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function mergeChartDrawings(current: ChartDrawings, incoming: ChartDrawings): ChartDrawings {
  return {
    trendlines: mergeUniqueById([...current.trendlines, ...incoming.trendlines]),
    rectangles: mergeUniqueById([...current.rectangles, ...incoming.rectangles]),
  };
}

function migrateLegacyDrawings(legacyDrawings: DrawingsState): DrawingsState {
  return Object.entries(legacyDrawings).reduce<DrawingsState>((next, [panelId, chartDrawings]) => {
    const symbol = DEFAULT_PANEL_SYMBOL_BY_ID[panelId];
    if (!symbol) return next;

    return {
      ...next,
      [symbol]: mergeChartDrawings(next[symbol] ?? EMPTY_CHART_DRAWINGS, chartDrawings),
    };
  }, {});
}

function readStoredDrawings(): DrawingsState {
  if (typeof window === "undefined") return {};

  try {
    const currentStored = window.localStorage.getItem(DRAWINGS_STORAGE_KEY);
    if (currentStored) {
      return normalizeDrawingsState(JSON.parse(currentStored));
    }

    const legacyStored = window.localStorage.getItem(LEGACY_DRAWINGS_STORAGE_KEY);
    if (!legacyStored) return {};

    return migrateLegacyDrawings(normalizeDrawingsState(JSON.parse(legacyStored)));
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
  magnet,
}: any) {
  const [vSplit, setVSplit] = useState(0.5);
  const [hSplit, setHSplit] = useState(0.5);
  const [panels, setPanels] = useState<Panel[]>(DEFAULT_PANELS);
  const [focused, setFocused] = useState<string | null>(null);
  const [drawingsBySymbol, setDrawingsBySymbol] = useState<DrawingsState>(() => readStoredDrawings());

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(drawingsBySymbol));
    } catch (error) {
      console.error("[LayoutManager] Failed to save drawings:", error);
    }
  }, [drawingsBySymbol]);

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
    magnet,
  };

  const updatePanel = useCallback((id: string, updates: Partial<Panel>) => {
    setPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, ...updates } : panel)));
  }, []);

  const getPanel = useCallback((id: string) => panels.find((panel) => panel.id === id)!, [panels]);

  const getSymbolDrawings = useCallback(
    (symbol: string): ChartDrawings => drawingsBySymbol[symbol] ?? EMPTY_CHART_DRAWINGS,
    [drawingsBySymbol]
  );

  const updateSymbolDrawings = useCallback(
    (symbol: string, updater: (current: ChartDrawings) => ChartDrawings) => {
      setDrawingsBySymbol((prev) => {
        const current = prev[symbol] ?? EMPTY_CHART_DRAWINGS;
        return {
          ...prev,
          [symbol]: updater(current),
        };
      });
    },
    []
  );

  const handleAddTrendline = useCallback(
    (symbol: string, line: Trendline) => {
      updateSymbolDrawings(symbol, (current) => ({
        trendlines: [...current.trendlines, line],
        rectangles: current.rectangles,
      }));
    },
    [updateSymbolDrawings]
  );

  const handleAddRectangle = useCallback(
    (symbol: string, rect: Rectangle) => {
      updateSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines,
        rectangles: [...current.rectangles, rect],
      }));
    },
    [updateSymbolDrawings]
  );

  const handleDeleteDrawing = useCallback(
    (symbol: string, id: string) => {
      updateSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines.filter((line) => line.id !== id),
        rectangles: current.rectangles.filter((rect) => rect.id !== id),
      }));
    },
    [updateSymbolDrawings]
  );

  const handleUpdateDrawing = useCallback(
    (
      symbol: string,
      selection: DrawingSelection,
      points: { start: Point; end: Point }
    ) => {
      updateSymbolDrawings(symbol, (current) => {
        if (selection.type === "trendline") {
          return {
            trendlines: current.trendlines.map((line) =>
              line.id === selection.id
                ? { ...line, start: points.start, end: points.end }
                : line
            ),
            rectangles: current.rectangles,
          };
        }

        return {
          trendlines: current.trendlines,
          rectangles: current.rectangles.map((rect) =>
            rect.id === selection.id
              ? { ...rect, start: points.start, end: points.end }
              : rect
          ),
        };
      });
    },
    [updateSymbolDrawings]
  );

  const renderPanel = (panel: Panel, onFocus: () => void) => (
    <ChartPanel
      panelId={panel.id}
      symbol={panel.symbol}
      timeframe={panel.timeframe}
      data={data[panel.symbol]?.[panel.timeframe] || []}
      drawings={getSymbolDrawings(panel.symbol)}
      onAddTrendline={handleAddTrendline}
      onAddRectangle={handleAddRectangle}
      onDeleteDrawing={handleDeleteDrawing}
      onUpdateDrawing={handleUpdateDrawing}
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
