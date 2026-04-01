import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ChartPanel from "./ChartPanel";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { useLayoutState } from "../store/useLayoutState";
import type {
  Candle,
  HistoryUiState,
  SupportedSymbol,
  Timeframe,
} from "../types/marketData";
import type { ReplayStartPayload } from "../types/replay";
import {
  DEFAULT_PANELS,
  FREE_TIER_VALIDATION_MODE,
  normalizeInstrumentId,
  sanitizePanelsForCapabilities,
} from "../instruments";
import {
  DEFAULT_TRENDLINE_EXTENSION,
  EMPTY_CHART_DRAWINGS,
  type ChartDrawings,
  type Drawing,
  type DrawingSelection,
  type DrawingType,
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

type DrawingHistoryEntry = {
  symbol: string;
  before: ChartDrawings;
  after: ChartDrawings;
};

type LayoutManagerProps = {
  data: Record<string, Record<Timeframe, Candle[]>>;
  layoutType: string;
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  tool?: string | null;
  magnet?: boolean;
  isReplay?: boolean;
  isReplaySelectingStart?: boolean;
  replaySelectionPanelId?: string | null;
  replayStartTime?: number | null;
  replayCursorTime?: number | null;
  replayIndex?: number;
  isReplaySync?: boolean;
  onReplayStart?: (payload: ReplayStartPayload) => void;
  supportedSymbols?: SupportedSymbol[];
  supportedTimeframes?: Timeframe[];
  showSessions?: boolean;
  showSessionLevels?: boolean;
  showSessionRanges?: boolean;
  showSma?: boolean;
  smaPeriod?: number;
  historyUiStates?: Record<string, HistoryUiState>;
  registerHistoryControls?: (controls: {
    canUndo: boolean;
    canRedo: boolean;
    undo: () => void;
    redo: () => void;
  }) => void;
};

const MAX_DRAWING_HISTORY = 100;

function normalizePoint(value: unknown): Point | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const maybeLine = value as {
    type?: unknown;
    id?: unknown;
    start?: unknown;
    end?: unknown;
    extend?: unknown;
  };
  const start = normalizePoint(maybeLine.start);
  const end = normalizePoint(maybeLine.end);
  if (!start || !end) {
    return null;
  }

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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const maybeRect = value as {
    type?: unknown;
    id?: unknown;
    start?: unknown;
    end?: unknown;
  };
  const start = normalizePoint(maybeRect.start);
  const end = normalizePoint(maybeRect.end);
  if (!start || !end) {
    return null;
  }

  return {
    type: normalizeDrawingType(maybeRect.type, "rectangle"),
    id: typeof maybeRect.id === "string" ? maybeRect.id : createDrawingId("rectangle"),
    start,
    end,
    ...normalizeBaseStyle(value),
  };
}

function normalizeTextDrawing(value: unknown): TextDrawing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

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
      ? maybeDrawings.trendlines
          .map(normalizeTrendline)
          .filter((line): line is Trendline => line !== null)
      : [],
    rectangles: Array.isArray(maybeDrawings.rectangles)
      ? maybeDrawings.rectangles
          .map(normalizeRectangle)
          .filter((rect): rect is Rectangle => rect !== null)
      : [],
    texts: Array.isArray(maybeDrawings.texts)
      ? maybeDrawings.texts
          .map(normalizeTextDrawing)
          .filter((text): text is TextDrawing => text !== null)
      : [],
  };
}

function mergeUniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function mergeChartDrawings(current: ChartDrawings, incoming: ChartDrawings): ChartDrawings {
  return {
    trendlines: mergeUniqueById([...current.trendlines, ...incoming.trendlines]),
    rectangles: mergeUniqueById([...current.rectangles, ...incoming.rectangles]),
    texts: mergeUniqueById([...current.texts, ...incoming.texts]),
  };
}

function normalizeDrawingsState(value: unknown): DrawingsState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<DrawingsState>(
    (next, [symbol, chartDrawings]) => {
      const normalizedSymbol = normalizeInstrumentId(symbol);
      const normalizedDrawings = normalizeChartDrawings(chartDrawings);

      return {
        ...next,
        [normalizedSymbol]: mergeChartDrawings(
          next[normalizedSymbol] ?? EMPTY_CHART_DRAWINGS,
          normalizedDrawings
        ),
      };
    },
    {}
  );
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

function cloneHistoryEntry(entry: DrawingHistoryEntry): DrawingHistoryEntry {
  return {
    symbol: entry.symbol,
    before: cloneChartDrawings(entry.before),
    after: cloneChartDrawings(entry.after),
  };
}

function pointEquals(left: Point, right: Point): boolean {
  return left.time === right.time && left.price === right.price;
}

function styleEquals(left: Partial<Drawing>, right: Partial<Drawing>): boolean {
  return (
    left.color === right.color &&
    left.width === right.width &&
    left.opacity === right.opacity
  );
}

function drawingEquals(left: Drawing, right: Drawing): boolean {
  if (left.type !== right.type || left.id !== right.id || !styleEquals(left, right)) {
    return false;
  }

  if (isTrendlineDrawing(left) && isTrendlineDrawing(right)) {
    return (
      pointEquals(left.start, right.start) &&
      pointEquals(left.end, right.end) &&
      left.extend === right.extend
    );
  }

  if (isRectangleDrawing(left) && isRectangleDrawing(right)) {
    return pointEquals(left.start, right.start) && pointEquals(left.end, right.end);
  }

  if (isTextDrawing(left) && isTextDrawing(right)) {
    return left.time === right.time && left.price === right.price && left.text === right.text;
  }

  return false;
}

function drawingArrayEquals<T extends Drawing>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (!drawingEquals(left[index], right[index])) {
      return false;
    }
  }

  return true;
}

function chartDrawingsEquals(left: ChartDrawings, right: ChartDrawings): boolean {
  return (
    drawingArrayEquals(left.trendlines, right.trendlines) &&
    drawingArrayEquals(left.rectangles, right.rectangles) &&
    drawingArrayEquals(left.texts, right.texts)
  );
}

function panelsEqual(left: Panel[], right: Panel[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].id !== right[index].id ||
      left[index].symbol !== right[index].symbol ||
      left[index].timeframe !== right[index].timeframe
    ) {
      return false;
    }
  }

  return true;
}

function isEmptyChartDrawings(drawings: ChartDrawings): boolean {
  return (
    drawings.trendlines.length === 0 &&
    drawings.rectangles.length === 0 &&
    drawings.texts.length === 0
  );
}

function setSymbolDrawingsState(
  current: DrawingsState,
  symbol: string,
  drawings: ChartDrawings
): DrawingsState {
  if (isEmptyChartDrawings(drawings)) {
    if (!(symbol in current)) {
      return current;
    }

    const nextState = { ...current };
    delete nextState[symbol];
    return nextState;
  }

  return {
    ...current,
    [symbol]: drawings,
  };
}

function clearPreviewState(
  current: Partial<DrawingsState>,
  symbol: string
): Partial<DrawingsState> {
  if (!(symbol in current)) {
    return current;
  }

  const nextState = { ...current };
  delete nextState[symbol];
  return nextState;
}

function trimHistoryStack(stack: DrawingHistoryEntry[]): DrawingHistoryEntry[] {
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
    if (!isTrendlineDrawing(nextDrawing)) {
      return current;
    }

    let found = false;
    const trendlines = current.trendlines.map((line) => {
      if (line.id !== selection.id) {
        return line;
      }

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
    if (!isRectangleDrawing(nextDrawing)) {
      return current;
    }

    let found = false;
    const rectangles = current.rectangles.map((rect) => {
      if (rect.id !== selection.id) {
        return rect;
      }

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

  if (!isTextDrawing(nextDrawing)) {
    return current;
  }

  let found = false;
  const texts = current.texts.map((text) => {
    if (text.id !== selection.id) {
      return text;
    }

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
  supportedSymbols = [],
  supportedTimeframes = ["1m", "3m"],
  showSessions,
  showSessionLevels,
  showSessionRanges,
  showSma,
  smaPeriod,
  historyUiStates,
  registerHistoryControls,
}: LayoutManagerProps) {
  const [vSplit, setVSplit] = useState(0.5);
  const [hSplit, setHSplit] = useState(0.5);
  const [panels, setPanels] = useState<Panel[]>(DEFAULT_PANELS);
  const [focused, setFocused] = useState<string | null>(null);
  const [drawingsBySymbol, setDrawingsBySymbol] = useState<DrawingsState>({});
  const [previewDrawingsBySymbol, setPreviewDrawingsBySymbol] =
    useState<Partial<DrawingsState>>({});
  const [hiddenSymbols, setHiddenSymbols] = useState<Record<string, boolean>>({});
  const [undoStack, setUndoStack] = useState<DrawingHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<DrawingHistoryEntry[]>([]);
  const [dirtyRevision, setDirtyRevision] = useState(0);

  const lastHydratedWorkspaceIdRef = useRef<string | null>(null);

  const { workspaces, activeWorkspaceId, updateWorkspace } = useWorkspaceStore();
  const {
    setPanels: setLayoutPanels,
    setDrawingsBySymbol: setLayoutDrawings,
    setFocusedPanelId,
  } = useLayoutState();

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces]
  );

  const sanitizePanelList = useCallback(
    (nextPanels: Panel[]) =>
      sanitizePanelsForCapabilities(nextPanels, supportedSymbols, supportedTimeframes),
    [supportedSymbols, supportedTimeframes]
  );

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

  useEffect(() => {
    if (!focused) {
      return;
    }

    if (panels.some((panel) => panel.id === focused)) {
      return;
    }

    console.warn(`[LayoutManager] Focus panel not found: ${focused}`);
    setFocused(null);
  }, [focused, panels]);

  useEffect(() => {
    if (FREE_TIER_VALIDATION_MODE) {
      lastHydratedWorkspaceIdRef.current = null;
      return;
    }

    if (!activeWorkspaceId || !activeWorkspace) {
      lastHydratedWorkspaceIdRef.current = null;
      return;
    }

    if (lastHydratedWorkspaceIdRef.current === activeWorkspaceId) {
      return;
    }

    const sanitizedPanels = sanitizePanelList(activeWorkspace.panels);
    const normalizedDrawings = normalizeDrawingsState(activeWorkspace.drawingsBySymbol);
    const requiresSanitizedPersist = !panelsEqual(activeWorkspace.panels, sanitizedPanels);

    lastHydratedWorkspaceIdRef.current = activeWorkspaceId;
    setPanels(sanitizedPanels);
    setDrawingsBySymbol(normalizedDrawings);
    setPreviewDrawingsBySymbol({});
    setUndoStack([]);
    setRedoStack([]);
    setDirtyRevision(requiresSanitizedPersist ? 1 : 0);
    setFocused((current) =>
      current && sanitizedPanels.some((panel) => panel.id === current) ? current : null
    );
  }, [activeWorkspace, activeWorkspaceId, sanitizePanelList]);

  useEffect(() => {
    setPanels((current) => {
      const sanitized = sanitizePanelList(current);
      if (panelsEqual(current, sanitized)) {
        return current;
      }

      setDirtyRevision((revision) => revision + 1);
      setFocused((currentFocused) =>
        currentFocused && sanitized.some((panel) => panel.id === currentFocused)
          ? currentFocused
          : null
      );
      return sanitized;
    });
  }, [sanitizePanelList]);

  useEffect(() => {
    if (FREE_TIER_VALIDATION_MODE || !activeWorkspaceId || dirtyRevision === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      updateWorkspace(activeWorkspaceId, {
        panels,
        drawingsBySymbol,
      });
    }, 750);

    return () => window.clearTimeout(timer);
  }, [activeWorkspaceId, dirtyRevision, drawingsBySymbol, panels, updateWorkspace]);

  const commitSymbolDrawings = useCallback(
    (symbol: string, updater: (current: ChartDrawings) => ChartDrawings) => {
      setDrawingsBySymbol((currentState) => {
        const currentDrawings = currentState[symbol] ?? EMPTY_CHART_DRAWINGS;
        const nextDrawings = updater(currentDrawings);

        if (chartDrawingsEquals(currentDrawings, nextDrawings)) {
          return currentState;
        }

        const historyEntry: DrawingHistoryEntry = {
          symbol,
          before: cloneChartDrawings(currentDrawings),
          after: cloneChartDrawings(nextDrawings),
        };

        setPreviewDrawingsBySymbol((prev) => clearPreviewState(prev, symbol));
        setUndoStack((prev) => trimHistoryStack([...prev, cloneHistoryEntry(historyEntry)]));
        setRedoStack([]);
        setDirtyRevision((revision) => revision + 1);

        return setSymbolDrawingsState(currentState, symbol, historyEntry.after);
      });
    },
    []
  );

  const previewSymbolDrawings = useCallback(
    (symbol: string, updater: (current: ChartDrawings) => ChartDrawings) => {
      setPreviewDrawingsBySymbol((currentPreviewState) => {
        const committedDrawings = drawingsBySymbol[symbol] ?? EMPTY_CHART_DRAWINGS;
        const currentPreview = currentPreviewState[symbol] ?? committedDrawings;
        const nextPreview = updater(currentPreview);

        if (chartDrawingsEquals(committedDrawings, nextPreview)) {
          return clearPreviewState(currentPreviewState, symbol);
        }

        const previousPreview = currentPreviewState[symbol];
        if (previousPreview && chartDrawingsEquals(previousPreview, nextPreview)) {
          return currentPreviewState;
        }

        return {
          ...currentPreviewState,
          [symbol]: cloneChartDrawings(nextPreview),
        };
      });
    },
    [drawingsBySymbol]
  );

  const updatePanel = useCallback(
    (id: string, updates: Partial<Panel>) => {
      setPanels((currentPanels) => {
        const nextPanels = sanitizePanelList(
          currentPanels.map((panel) =>
            panel.id === id
              ? {
                  ...panel,
                  ...updates,
                  symbol: updates.symbol
                    ? normalizeInstrumentId(updates.symbol)
                    : panel.symbol,
                }
              : panel
          )
        );

        if (panelsEqual(currentPanels, nextPanels)) {
          return currentPanels;
        }

        setDirtyRevision((revision) => revision + 1);
        return nextPanels;
      });
    },
    [sanitizePanelList]
  );

  const getDisplayedSymbolDrawings = useCallback(
    (symbol: string): ChartDrawings =>
      previewDrawingsBySymbol[symbol] ?? drawingsBySymbol[symbol] ?? EMPTY_CHART_DRAWINGS,
    [drawingsBySymbol, previewDrawingsBySymbol]
  );

  const handleAddTrendline = useCallback(
    (symbol: string, line: Trendline) => {
      commitSymbolDrawings(symbol, (current) => ({
        trendlines: [...current.trendlines, cloneDrawing(line)],
        rectangles: current.rectangles,
        texts: current.texts,
      }));
    },
    [commitSymbolDrawings]
  );

  const handleAddRectangle = useCallback(
    (symbol: string, rect: Rectangle) => {
      commitSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines,
        rectangles: [...current.rectangles, cloneDrawing(rect)],
        texts: current.texts,
      }));
    },
    [commitSymbolDrawings]
  );

  const handleAddText = useCallback(
    (symbol: string, text: TextDrawing) => {
      commitSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines,
        rectangles: current.rectangles,
        texts: [...current.texts, cloneDrawing(text)],
      }));
    },
    [commitSymbolDrawings]
  );

  const handleDeleteDrawing = useCallback(
    (symbol: string, id: string) => {
      commitSymbolDrawings(symbol, (current) => ({
        trendlines: current.trendlines.filter((line) => line.id !== id),
        rectangles: current.rectangles.filter((rect) => rect.id !== id),
        texts: current.texts.filter((text) => text.id !== id),
      }));
    },
    [commitSymbolDrawings]
  );

  const handleUpdateDrawing = useCallback(
    (symbol: string, selection: DrawingSelection, nextDrawing: Drawing) => {
      commitSymbolDrawings(symbol, (current) =>
        applyDrawingUpdate(current, selection, nextDrawing)
      );
    },
    [commitSymbolDrawings]
  );

  const handlePreviewDrawing = useCallback(
    (symbol: string, selection: DrawingSelection, nextDrawing: Drawing) => {
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
      _previousDrawing: Drawing,
      nextDrawing: Drawing
    ) => {
      setDrawingsBySymbol((currentState) => {
        const currentDrawings = currentState[symbol] ?? EMPTY_CHART_DRAWINGS;
        const nextDrawings = applyDrawingUpdate(currentDrawings, selection, nextDrawing);

        setPreviewDrawingsBySymbol((prev) => clearPreviewState(prev, symbol));

        if (chartDrawingsEquals(currentDrawings, nextDrawings)) {
          return currentState;
        }

        const historyEntry: DrawingHistoryEntry = {
          symbol,
          before: cloneChartDrawings(currentDrawings),
          after: cloneChartDrawings(nextDrawings),
        };

        setUndoStack((prev) => trimHistoryStack([...prev, cloneHistoryEntry(historyEntry)]));
        setRedoStack([]);
        setDirtyRevision((revision) => revision + 1);

        return setSymbolDrawingsState(currentState, symbol, historyEntry.after);
      });
    },
    []
  );

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  const undoDrawings = useCallback(() => {
    setUndoStack((currentUndoStack) => {
      const entry = currentUndoStack[currentUndoStack.length - 1];
      if (!entry) {
        return currentUndoStack;
      }

      setDrawingsBySymbol((currentState) =>
        setSymbolDrawingsState(currentState, entry.symbol, cloneChartDrawings(entry.before))
      );
      setPreviewDrawingsBySymbol((prev) => clearPreviewState(prev, entry.symbol));
      setRedoStack((prev) => trimHistoryStack([...prev, cloneHistoryEntry(entry)]));
      setDirtyRevision((revision) => revision + 1);

      return currentUndoStack.slice(0, -1);
    });
  }, []);

  const redoDrawings = useCallback(() => {
    setRedoStack((currentRedoStack) => {
      const entry = currentRedoStack[currentRedoStack.length - 1];
      if (!entry) {
        return currentRedoStack;
      }

      setDrawingsBySymbol((currentState) =>
        setSymbolDrawingsState(currentState, entry.symbol, cloneChartDrawings(entry.after))
      );
      setPreviewDrawingsBySymbol((prev) => clearPreviewState(prev, entry.symbol));
      setUndoStack((prev) => trimHistoryStack([...prev, cloneHistoryEntry(entry)]));
      setDirtyRevision((revision) => revision + 1);

      return currentRedoStack.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    registerHistoryControls?.({
      canUndo,
      canRedo,
      undo: undoDrawings,
      redo: redoDrawings,
    });
  }, [canRedo, canUndo, redoDrawings, registerHistoryControls, undoDrawings]);

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

  const clearDrawings = useCallback(
    (symbol: string) => {
      commitSymbolDrawings(symbol, () => EMPTY_CHART_DRAWINGS);
    },
    [commitSymbolDrawings]
  );

  const renderPanel = useCallback(
    (panel: Panel, onFocus: () => void) => (
      <ChartPanel
        panelId={panel.id}
        symbol={panel.symbol}
        timeframe={panel.timeframe}
        data={data[panel.symbol]?.[panel.timeframe] ?? []}
        drawings={getDisplayedSymbolDrawings(panel.symbol)}
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
        supportedSymbols={supportedSymbols}
        supportedTimeframes={supportedTimeframes}
        onSymbolChange={(symbol) => updatePanel(panel.id, { symbol })}
        onTimeframeChange={(timeframe) => updatePanel(panel.id, { timeframe })}
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
        onReplayStart={onReplayStart}
        historyUiState={
          historyUiStates?.[`${panel.symbol}::${panel.timeframe}`] ?? {
            status: "idle",
            message: null,
          }
        }
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undoDrawings}
        onRedo={redoDrawings}
        showSessions={showSessions}
        showSessionLevels={showSessionLevels}
        showSessionRanges={showSessionRanges}
        showSma={showSma}
        smaPeriod={smaPeriod}
      />
    ),
    [
      activeChart,
      canRedo,
      canUndo,
      clearDrawings,
      data,
      getDisplayedSymbolDrawings,
      handleAddRectangle,
      handleAddText,
      handleAddTrendline,
      handleCommitPreviewDrawing,
      handleDeleteDrawing,
      handlePreviewDrawing,
      handleUpdateDrawing,
      hiddenSymbols,
      historyUiStates,
      isReplay,
      isReplaySelectingStart,
      isReplaySync,
      magnet,
      onReplayStart,
      redoDrawings,
      replayCursorTime,
      replayIndex,
      replaySelectionPanelId,
      replayStartTime,
      setActiveChart,
      showDrawings,
      showSessionLevels,
      showSessionRanges,
      showSessions,
      showSma,
      smaPeriod,
      supportedSymbols,
      supportedTimeframes,
      tool,
      undoDrawings,
      updatePanel,
    ]
  );

  const startVerticalResize = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      setVSplit(Math.max(0.2, Math.min(0.8, moveEvent.clientX / window.innerWidth)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const startHorizontalResize = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      setHSplit(Math.max(0.2, Math.min(0.8, moveEvent.clientY / window.innerHeight)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  if (focused) {
    const panel = panels.find((candidate) => candidate.id === focused);
    if (!panel) {
      return null;
    }

    return (
      <div className="focus-mode">
        <div className="focus-mode__header">
          <button onClick={() => setFocused(null)}>Back</button>
        </div>
        <div className="focus-mode__content">{renderPanel(panel, () => setFocused(null))}</div>
      </div>
    );
  }

  if (FREE_TIER_VALIDATION_MODE || layoutType === "1" || panels.length <= 1) {
    const panel = panels[0];
    if (!panel) {
      return null;
    }

    return (
      <div className="layout-engine">
        <div style={{ position: "absolute", inset: 0 }}>
          {renderPanel(panel, () => setFocused(panel.id))}
        </div>
      </div>
    );
  }

  if (layoutType === "2") {
    const [p0, p1] = panels;
    if (!p0 || !p1) {
      return null;
    }

    return (
      <div className="layout-engine">
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: `${vSplit * 100}%`,
            height: "100%",
          }}
        >
          {renderPanel(p0, () => setFocused(p0.id))}
        </div>

        <div
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: 0,
            width: `${(1 - vSplit) * 100}%`,
            height: "100%",
          }}
        >
          {renderPanel(p1, () => setFocused(p1.id))}
        </div>

        <div
          onMouseDown={startVerticalResize}
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: 0,
            width: "6px",
            height: "100%",
            cursor: "col-resize",
            zIndex: 50,
            transform: "translateX(-3px)",
          }}
        />
      </div>
    );
  }

  if (layoutType === "3") {
    const [p0, p1, p2] = panels;
    if (!p0 || !p1 || !p2) {
      return null;
    }

    return (
      <div className="layout-engine">
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: `${vSplit * 100}%`,
            height: "100%",
          }}
        >
          {renderPanel(p0, () => setFocused(p0.id))}
        </div>

        <div
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: 0,
            width: `${(1 - vSplit) * 100}%`,
            height: `${hSplit * 100}%`,
          }}
        >
          {renderPanel(p1, () => setFocused(p1.id))}
        </div>

        <div
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: `${hSplit * 100}%`,
            width: `${(1 - vSplit) * 100}%`,
            height: `${(1 - hSplit) * 100}%`,
          }}
        >
          {renderPanel(p2, () => setFocused(p2.id))}
        </div>

        <div
          onMouseDown={startVerticalResize}
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: 0,
            width: "6px",
            height: "100%",
            cursor: "col-resize",
            transform: "translateX(-3px)",
            zIndex: 50,
          }}
        />
        <div
          onMouseDown={startHorizontalResize}
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: `${hSplit * 100}%`,
            width: `${(1 - vSplit) * 100}%`,
            height: "6px",
            cursor: "row-resize",
            transform: "translateY(-3px)",
            zIndex: 50,
          }}
        />
      </div>
    );
  }

  if (layoutType === "6") {
    return (
      <div className="layout-engine">
        {panels.map((panel, index) => (
          <div
            key={panel.id}
            style={{
              position: "absolute",
              left: `${(index % 3) * 33.33}%`,
              top: index < 3 ? "0%" : "50%",
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
