import { useCallback, useEffect, useState } from "react";
import ChartPanel from "./ChartPanel";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { useLayoutState } from "../store/useLayoutState";
import type { SupportedSymbol, Timeframe } from "../types/marketData";
import {
  DEFAULT_TRENDLINE_EXTENSION,
  EMPTY_CHART_DRAWINGS,
  type ChartDrawings,
  type Drawing,
  type DrawingType,
  type DrawingSelection,
  type DrawingsState,
  type LineExtension,
  type Point,
  type Rectangle,
  type TextDrawing,
  type Trendline,
  createDrawingId,
  isRectangleDrawing,
  isTextDrawing,
  isTrendlineDrawing,
} from "../types/drawings";

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

const DRAWINGS_STORAGE_KEY = "layout-manager-drawings-v2";
const LEGACY_DRAWINGS_STORAGE_KEY = "layout-manager-drawings-v1";
const MAX_DRAWING_HISTORY = 100;
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

function normalizeDrawingType<T extends DrawingType>(value: unknown, fallback: T): T {
  return value === fallback ? fallback : fallback;
}

function normalizeBaseStyle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const maybe = value as {
    color?: unknown;
    width?: unknown;
    opacity?: unknown;
  };

  return {
    color: typeof maybe.color === "string" ? maybe.color : undefined,
    width: typeof maybe.width === "number" ? maybe.width : undefined,
    opacity: typeof maybe.opacity === "number" ? maybe.opacity : undefined,
  };
}

function normalizeTrendline(value: unknown): Trendline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const maybeLine = value as {
    type?: unknown;
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
    type: normalizeDrawingType(maybeLine.type, "trendline"),
    id: typeof maybeLine.id === "string" ? maybeLine.id : createDrawingId("trendline"),
    start,
    end,
    extend,
    ...normalizeBaseStyle(value),
  };
}

function normalizeRectangle(value: unknown): Rectangle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const maybeRect = value as {
    type?: unknown;
    id?: unknown;
    start?: unknown;
    end?: unknown;
  };
  const start = normalizePoint(maybeRect.start);
  const end = normalizePoint(maybeRect.end);
  if (!start || !end) return null;

  return {
    type: normalizeDrawingType(maybeRect.type, "rectangle"),
    id: typeof maybeRect.id === "string" ? maybeRect.id : createDrawingId("rectangle"),
    start,
    end,
    ...normalizeBaseStyle(value),
  };
}

function normalizeTextDrawing(value: unknown): TextDrawing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const maybeText = value as {
    type?: unknown;
    id?: unknown;
    time?: unknown;
    price?: unknown;
    text?: unknown;
  };
  if (typeof maybeText.time !== "number" || typeof maybeText.price !== "number") {
    return null;
  }

  return {
    type: normalizeDrawingType(maybeText.type, "text"),
    id: typeof maybeText.id === "string" ? maybeText.id : createDrawingId("text"),
    time: maybeText.time as Point["time"],
    price: maybeText.price,
    text: typeof maybeText.text === "string" ? maybeText.text : "Text",
    ...normalizeBaseStyle(value),
  };
}

function normalizeChartDrawings(value: unknown): ChartDrawings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_CHART_DRAWINGS;
  }

  const maybeDrawings = value as {
    trendlines?: unknown;
    rectangles?: unknown;
    texts?: unknown;
  };
  return {
    trendlines: Array.isArray(maybeDrawings.trendlines)
      ? maybeDrawings.trendlines.map(normalizeTrendline).filter((line): line is Trendline => line !== null)
      : [],
    rectangles: Array.isArray(maybeDrawings.rectangles)
      ? maybeDrawings.rectangles.map(normalizeRectangle).filter((rect): rect is Rectangle => rect !== null)
      : [],
    texts: Array.isArray(maybeDrawings.texts)
      ? maybeDrawings.texts.map(normalizeTextDrawing).filter((text): text is TextDrawing => text !== null)
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

function cloneDrawing<T extends Drawing>(drawing: T): T {
  if (isTrendlineDrawing(drawing) || isRectangleDrawing(drawing)) {
    return {
      ...drawing,
      start: { ...drawing.start },
      end: { ...drawing.end },
    } as T;
  }

  return { ...drawing } as T;
}

function cloneChartDrawings(value: ChartDrawings): ChartDrawings {
  return {
    trendlines: value.trendlines.map((line) => cloneDrawing(line)),
    rectangles: value.rectangles.map((rect) => cloneDrawing(rect)),
    texts: value.texts.map((text) => cloneDrawing(text)),
  };
}

function cloneDrawingsState(value: DrawingsState): DrawingsState {
  return Object.fromEntries(
    Object.entries(value).map(([symbol, drawings]) => [
      symbol,
      cloneChartDrawings(drawings),
    ])
  );
}

function chartDrawingsEquals(a: ChartDrawings, b: ChartDrawings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function drawingsStateEquals(a: DrawingsState, b: DrawingsState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function trimHistoryStack(stack: DrawingsState[]): DrawingsState[] {
  return stack.length > MAX_DRAWING_HISTORY
    ? stack.slice(stack.length - MAX_DRAWING_HISTORY)
    : stack;
}

function applyDrawingUpdate(
  current: ChartDrawings,
  selection: DrawingSelection,
  nextDrawing: Drawing
): ChartDrawings {
  if (selection.type === "trendline") {
    if (!isTrendlineDrawing(nextDrawing)) return current;

    let found = false;
    const trendlines = current.trendlines.map((line) => {
      if (line.id !== selection.id) return line;
      found = true;
      return cloneDrawing(nextDrawing);
    });

    return found
      ? {
          trendlines,
          rectangles: current.rectangles,
          texts: current.texts,
        }
      : current;
  }

  if (selection.type === "rectangle") {
    if (!isRectangleDrawing(nextDrawing)) return current;

    let found = false;
    const rectangles = current.rectangles.map((rect) => {
      if (rect.id !== selection.id) return rect;
      found = true;
      return cloneDrawing(nextDrawing);
    });

    return found
      ? {
          trendlines: current.trendlines,
          rectangles,
          texts: current.texts,
        }
      : current;
  }

  if (!isTextDrawing(nextDrawing)) return current;

  let found = false;
  const texts = current.texts.map((text) => {
    if (text.id !== selection.id) return text;
    found = true;
    return cloneDrawing(nextDrawing);
  });

  return found
    ? {
        trendlines: current.trendlines,
        rectangles: current.rectangles,
        texts,
      }
    : current;
}

function mergeChartDrawings(current: ChartDrawings, incoming: ChartDrawings): ChartDrawings {
  return {
    trendlines: mergeUniqueById([...current.trendlines, ...incoming.trendlines]),
    rectangles: mergeUniqueById([...current.rectangles, ...incoming.rectangles]),
    texts: mergeUniqueById([...current.texts, ...incoming.texts]),
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
  tool,
  magnet,
  isReplay,
  isReplaySelectingStart,
  replaySelectionPanelId,
  replayStartTime,
  replayCursorTime,
  replayIndex,
  isReplaySync,
  onReplayStart,
  supportedSymbols,
  showSessions,
  registerHistoryControls,
}: any) {
  const [vSplit, setVSplit] = useState(0.5);
  const [hSplit, setHSplit] = useState(0.5);
  const [panels, setPanels] = useState<Panel[]>(DEFAULT_PANELS);
  const [focused, setFocused] = useState<string | null>(null);
  const [drawingsBySymbol, setDrawingsBySymbol] = useState<DrawingsState>(() => readStoredDrawings());
  const [hiddenSymbols, setHiddenSymbols] = useState<Record<string, boolean>>({});
  const [undoStack, setUndoStack] = useState<DrawingsState[]>([]);
  const [redoStack, setRedoStack] = useState<DrawingsState[]>([]);

  const { workspaces, activeWorkspaceId, updateWorkspace } = useWorkspaceStore();
  const {
    setPanels: setLayoutPanels,
    setDrawingsBySymbol: setLayoutDrawings,
    setFocusedPanelId,
  } = useLayoutState();

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(drawingsBySymbol));
    } catch (error) {
      console.error("[LayoutManager] Failed to save drawings:", error);
    }
  }, [drawingsBySymbol]);

  // Sync layout state to global store
  useEffect(() => {
    setLayoutPanels(panels);
  }, [panels, setLayoutPanels]);

  useEffect(() => {
    setLayoutDrawings(drawingsBySymbol);
  }, [drawingsBySymbol, setLayoutDrawings]);

  useEffect(() => {
    setFocusedPanelId(focused);
  }, [focused, setFocusedPanelId]);

  useEffect(() => {
    return () => {
      setFocusedPanelId(null);
    };
  }, [setFocusedPanelId]);

  // Load workspace when activeWorkspaceId changes
  useEffect(() => {
    if (!activeWorkspaceId) return;

    const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!workspace) return;

    // Apply workspace state
    setPanels(workspace.panels);
    setDrawingsBySymbol(normalizeDrawingsState(workspace.drawingsBySymbol));
    setUndoStack([]);
    setRedoStack([]);
    // layoutType is controlled by parent, so we don't modify it here
  }, [activeWorkspaceId, workspaces]);

  // Auto-save workspace changes (debounced 1000ms)
  useEffect(() => {
    if (!activeWorkspaceId) return;

    const timer = setTimeout(() => {
      updateWorkspace(activeWorkspaceId, {
        panels,
        drawingsBySymbol,
        layoutType,
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, [panels, drawingsBySymbol, layoutType, activeWorkspaceId, updateWorkspace]);

  const sharedProps = {
    activeChart,
    setActiveChart,
    tool,
    magnet,
  };

  const updatePanel = useCallback((id: string, updates: Partial<Panel>) => {
    setPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, ...updates } : panel)));
  }, []);

  const getSymbolDrawings = useCallback(
    (symbol: string): ChartDrawings => drawingsBySymbol[symbol] ?? EMPTY_CHART_DRAWINGS,
    [drawingsBySymbol]
  );

  const commitDrawingsChange = useCallback(
    (updater: (current: DrawingsState) => DrawingsState) => {
      setDrawingsBySymbol((current) => {
        const before = cloneDrawingsState(current);
        const after = updater(current);

        if (drawingsStateEquals(before, after)) {
          return current;
        }

        setUndoStack((prev) => trimHistoryStack([...prev, before]));
        setRedoStack([]);
        return after;
      });
    },
    []
  );

  const updateSymbolDrawings = useCallback(
    (symbol: string, updater: (current: ChartDrawings) => ChartDrawings) => {
      commitDrawingsChange((prev) => {
        const current = prev[symbol] ?? EMPTY_CHART_DRAWINGS;
        const next = updater(current);
        if (chartDrawingsEquals(current, next)) {
          return prev;
        }
        return {
          ...prev,
          [symbol]: next,
        };
      });
    },
    [commitDrawingsChange]
  );

  const previewSymbolDrawings = useCallback(
    (symbol: string, updater: (current: ChartDrawings) => ChartDrawings) => {
      setDrawingsBySymbol((prev) => {
        const current = prev[symbol] ?? EMPTY_CHART_DRAWINGS;
        const next = updater(current);
        if (chartDrawingsEquals(current, next)) {
          return prev;
        }

        return {
          ...prev,
          [symbol]: next,
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
        texts: current.texts,
      }));
    },
    [updateSymbolDrawings]
  );

  const handleAddRectangle = useCallback(
    (symbol: string, rect: Rectangle) => {
      updateSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines,
        rectangles: [...current.rectangles, rect],
        texts: current.texts,
      }));
    },
    [updateSymbolDrawings]
  );

  const handleAddText = useCallback(
    (symbol: string, text: TextDrawing) => {
      updateSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines,
        rectangles: current.rectangles,
        texts: [...current.texts, text],
      }));
    },
    [updateSymbolDrawings]
  );

  const handleDeleteDrawing = useCallback(
    (symbol: string, id: string) => {
      updateSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines.filter((line) => line.id !== id),
        rectangles: current.rectangles.filter((rect) => rect.id !== id),
        texts: current.texts.filter((text) => text.id !== id),
      }));
    },
    [updateSymbolDrawings]
  );

  const handleUpdateDrawing = useCallback(
    (
      symbol: string,
      selection: DrawingSelection,
      nextDrawing: Drawing
    ) => {
      updateSymbolDrawings(symbol, (current) =>
        applyDrawingUpdate(current, selection, nextDrawing)
      );
    },
    [updateSymbolDrawings]
  );

  const handlePreviewDrawing = useCallback(
    (
      symbol: string,
      selection: DrawingSelection,
      nextDrawing: Drawing
    ) => {
      previewSymbolDrawings(symbol, (current) =>
        applyDrawingUpdate(current, selection, nextDrawing)
      );
    },
    [previewSymbolDrawings]
  );

  const handleCommitPreviewDrawing = useCallback(
    (
      symbol: string,
      selection: DrawingSelection,
      previousDrawing: Drawing,
      nextDrawing: Drawing
    ) => {
      setDrawingsBySymbol((currentState) => {
        const currentSymbolDrawings = currentState[symbol] ?? EMPTY_CHART_DRAWINGS;
        const beforeState = cloneDrawingsState(currentState);
        const afterState = cloneDrawingsState(currentState);

        beforeState[symbol] = applyDrawingUpdate(
          beforeState[symbol] ?? EMPTY_CHART_DRAWINGS,
          selection,
          previousDrawing
        );
        afterState[symbol] = applyDrawingUpdate(
          currentSymbolDrawings,
          selection,
          nextDrawing
        );

        if (drawingsStateEquals(beforeState, afterState)) {
          return currentState;
        }

        setUndoStack((prev) => trimHistoryStack([...prev, beforeState]));
        setRedoStack([]);
        return afterState;
      });
    },
    []
  );

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  const undoDrawings = useCallback(() => {
    setUndoStack((prevUndo) => {
      if (prevUndo.length === 0) return prevUndo;

      const previous = prevUndo[prevUndo.length - 1];

      setDrawingsBySymbol((current) => {
        setRedoStack((prevRedo) =>
          trimHistoryStack([...prevRedo, cloneDrawingsState(current)])
        );
        return cloneDrawingsState(previous);
      });

      return prevUndo.slice(0, -1);
    });
  }, []);

  const redoDrawings = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;

      const next = prevRedo[prevRedo.length - 1];

      setDrawingsBySymbol((current) => {
        setUndoStack((prevUndo) =>
          trimHistoryStack([...prevUndo, cloneDrawingsState(current)])
        );
        return cloneDrawingsState(next);
      });

      return prevRedo.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    registerHistoryControls?.({
      canUndo,
      canRedo,
      undo: undoDrawings,
      redo: redoDrawings,
    });
  }, [registerHistoryControls, canUndo, canRedo, undoDrawings, redoDrawings]);

  const hideDrawings = useCallback((symbol: string) => {
    setHiddenSymbols((prev) => ({
      ...prev,
      [symbol]: true,
    }));
  }, []);

  const showDrawings = useCallback((symbol: string) => {
    setHiddenSymbols((prev) => ({
      ...prev,
      [symbol]: false,
    }));
  }, []);

  const clearDrawings = useCallback((symbol: string) => {
    updateSymbolDrawings(symbol, () => ({
      trendlines: [],
      rectangles: [],
      texts: [],
    }));
  }, [updateSymbolDrawings]);

  const renderPanel = (panel: Panel, onFocus: () => void) => (
    <ChartPanel
      panelId={panel.id}
      symbol={panel.symbol}
      timeframe={panel.timeframe}
      data={data[panel.symbol]?.[panel.timeframe] || []}
      drawings={getSymbolDrawings(panel.symbol)}
      drawingsHidden={hiddenSymbols[panel.symbol] === true}
      onAddTrendline={handleAddTrendline}
      onAddRectangle={handleAddRectangle}
      onAddText={handleAddText}
      onDeleteDrawing={handleDeleteDrawing}
      onUpdateDrawing={handleUpdateDrawing}
      onPreviewDrawing={handlePreviewDrawing}
      onCommitPreviewDrawing={handleCommitPreviewDrawing}
      onHideDrawings={() => hideDrawings(panel.symbol)}
      onShowDrawings={() => showDrawings(panel.symbol)}
      onClearDrawings={() => clearDrawings(panel.symbol)}
      onFocus={onFocus}
      supportedSymbols={supportedSymbols as SupportedSymbol[] | undefined}
      onSymbolChange={(symbol) => updatePanel(panel.id, { symbol })}
      onTimeframeChange={(timeframe) => updatePanel(panel.id, { timeframe })}
      isReplay={isReplay}
      isReplaySelectingStart={isReplaySelectingStart}
      replaySelectionPanelId={replaySelectionPanelId}
      replayStartTime={replayStartTime}
      replayCursorTime={replayCursorTime}
      replayIndex={replayIndex}
      isReplaySync={isReplaySync}
      onReplayStart={onReplayStart}
      canUndo={canUndo}
      canRedo={canRedo}
      onUndo={undoDrawings}
      onRedo={redoDrawings}
      showSessions={showSessions}
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
    const panel = panels.find((p) => p.id === focused);
    if (!panel) {
      console.warn(`[LayoutManager] Focus panel not found: ${focused}`);
      setFocused(null);
      return null;
    }
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
