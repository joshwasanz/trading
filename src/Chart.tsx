import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  CrosshairMode,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useToolStore } from "./store/useToolStore";
import { useThemeStore } from "./store/useThemeStore";
import { useCandleStore } from "./store/useCandleStore";
import DrawingStylePanel from "./components/DrawingStylePanel";
import type { Candle } from "./types/marketData";
import type { ReplayStartPayload } from "./types/replay";
import { SESSION_CONFIG, getSessionRange, type SessionKey } from "./types/sessions";
import { formatReplayTime } from "./utils/replayDisplay";
import {
  DEFAULT_TRENDLINE_EXTENSION,
  createDrawingId,
  type ChartDrawings,
  type Drawing,
  type DrawingSelection,
  type LineExtension,
  type Point,
  type Rectangle,
  type TextDrawing,
  type Trendline,
  isPointDrawing,
  isTextDrawing,
} from "./types/drawings";
import { findCandleIndexAtOrBefore } from "./utils/replay";

function getTimeframeSeconds(timeframe: ReplayStartPayload["timeframe"]): number {
  switch (timeframe) {
    case "15s":
      return 15;
    case "1m":
      return 60;
    case "3m":
      return 180;
    default:
      return 60;
  }
}

function resolveTimeFromLogicalIndex(
  logical: number,
  candles: Candle[],
  timeframe: ReplayStartPayload["timeframe"]
): UTCTimestamp | null {
  if (!candles.length || !Number.isFinite(logical)) return null;

  const timeframeSeconds = getTimeframeSeconds(timeframe);

  if (logical <= 0) {
    return (candles[0].time + logical * timeframeSeconds) as UTCTimestamp;
  }

  if (logical <= candles.length - 1) {
    const index = Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
    return candles[index].time as UTCTimestamp;
  }

  const extraSteps = logical - (candles.length - 1);
  return (candles[candles.length - 1].time + extraSteps * timeframeSeconds) as UTCTimestamp;
}

type Props = {
  data: Candle[];
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  chartId: string;
  symbol: string;
  timeframe: ReplayStartPayload["timeframe"];
  drawings: ChartDrawings;
  onAddTrendline: (line: Trendline) => void;
  onAddRectangle: (rect: Rectangle) => void;
  onAddText: (text: TextDrawing) => void;
  onDeleteDrawing?: (id: string) => void;
  onUpdateDrawing?: (selection: DrawingSelection, drawing: Drawing) => void;
  onPreviewDrawing?: (selection: DrawingSelection, drawing: Drawing) => void;
  onCommitPreviewDrawing?: (
    selection: DrawingSelection,
    previousDrawing: Drawing,
    nextDrawing: Drawing
  ) => void;
  tool?: string | null;
  magnet?: boolean;
  hidden?: boolean;
  isReplay?: boolean;
  isReplaySelectingStart?: boolean;
  replaySelectionPanelId?: string | null;
  replayStartTime?: number | null;
  replayCursorTime?: number | null;
  replayIndex?: number;
  isReplaySync?: boolean;
  onReplayStart?: (payload: ReplayStartPayload) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  showSessions?: boolean;
};

type ScreenPoint = {
  x: number;
  y: number;
};

type DragMode =
  | "move"
  | "resize-start"
  | "resize-end"
  | "resize-left"
  | "resize-right"
  | "resize-top"
  | "resize-bottom";

type DragTarget = {
  selection: DrawingSelection;
  dragMode: DragMode;
};

const TEXT_FONT_SIZE = 12;
const TEXT_PADDING_X = 4;
const TEXT_PADDING_Y = 3;
const SESSION_KEYS: SessionKey[] = ["asia", "london", "newyork"];

function getLineBoundaryIntersections(
  start: ScreenPoint,
  end: ScreenPoint,
  width: number,
  height: number
): Array<{ point: ScreenPoint; t: number }> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) return [];

  const intersections: Array<{ point: ScreenPoint; t: number }> = [];

  const pushIntersection = (x: number, y: number, t: number) => {
    const duplicate = intersections.some(
      ({ point }) => Math.abs(point.x - x) < 0.5 && Math.abs(point.y - y) < 0.5
    );
    if (!duplicate) {
      intersections.push({ point: { x, y }, t });
    }
  };

  if (dx !== 0) {
    const leftT = (0 - start.x) / dx;
    const leftY = start.y + leftT * dy;
    if (leftY >= 0 && leftY <= height) pushIntersection(0, leftY, leftT);

    const rightT = (width - start.x) / dx;
    const rightY = start.y + rightT * dy;
    if (rightY >= 0 && rightY <= height) pushIntersection(width, rightY, rightT);
  }

  if (dy !== 0) {
    const topT = (0 - start.y) / dy;
    const topX = start.x + topT * dx;
    if (topX >= 0 && topX <= width) pushIntersection(topX, 0, topT);

    const bottomT = (height - start.y) / dy;
    const bottomX = start.x + bottomT * dx;
    if (bottomX >= 0 && bottomX <= width) pushIntersection(bottomX, height, bottomT);
  }

  return intersections.sort((a, b) => a.t - b.t);
}

function getTrendlineSegment(
  start: ScreenPoint,
  end: ScreenPoint,
  extend: LineExtension,
  width: number,
  height: number
): { start: ScreenPoint; end: ScreenPoint } | null {
  if (extend === "none") {
    return { start, end };
  }

  const [leftAnchor, rightAnchor] = start.x <= end.x ? [start, end] : [end, start];
  const intersections = getLineBoundaryIntersections(
    leftAnchor,
    rightAnchor,
    width,
    height
  );

  if (intersections.length < 2) {
    return { start: leftAnchor, end: rightAnchor };
  }

  if (extend === "both") {
    return {
      start: intersections[0].point,
      end: intersections[intersections.length - 1].point,
    };
  }

  return {
    start: leftAnchor,
    end: intersections[intersections.length - 1].point,
  };
}

function distancePointToSegment(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint): number {
  const a = point.x - start.x;
  const b = point.y - start.y;
  const c = end.x - start.x;
  const d = end.y - start.y;

  const dot = a * c + b * d;
  const lenSq = c * c + d * d;
  let param = -1;

  if (lenSq !== 0) {
    param = dot / lenSq;
  }

  let xx: number;
  let yy: number;

  if (param < 0) {
    xx = start.x;
    yy = start.y;
  } else if (param > 1) {
    xx = end.x;
    yy = end.y;
  } else {
    xx = start.x + param * c;
    yy = start.y + param * d;
  }

  const dx = point.x - xx;
  const dy = point.y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

function pointHitsRectangle(
  point: ScreenPoint,
  start: ScreenPoint,
  end: ScreenPoint,
  padding: number
): boolean {
  const left = Math.min(start.x, end.x) - padding;
  const right = Math.max(start.x, end.x) + padding;
  const top = Math.min(start.y, end.y) - padding;
  const bottom = Math.max(start.y, end.y) + padding;

  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function getRectangleBounds(start: ScreenPoint, end: ScreenPoint) {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  return {
    left,
    right,
    top,
    bottom,
    topLeft: { x: left, y: top },
    topRight: { x: right, y: top },
    bottomLeft: { x: left, y: bottom },
    bottomRight: { x: right, y: bottom },
  };
}

function drawSelectionHandle(
  ctx: CanvasRenderingContext2D,
  point: ScreenPoint,
  radius: number
) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function isNearPoint(
  point: ScreenPoint,
  target: ScreenPoint,
  threshold: number
): boolean {
  return Math.hypot(point.x - target.x, point.y - target.y) <= threshold;
}

function getDragModeCursor(dragMode: DragMode): string {
  if (dragMode === "resize-left" || dragMode === "resize-right") {
    return "ew-resize";
  }

  if (dragMode === "resize-top" || dragMode === "resize-bottom") {
    return "ns-resize";
  }

  if (dragMode === "move") {
    return "grab";
  }

  return "pointer";
}

function applyTextFont(ctx: CanvasRenderingContext2D, dpr: number) {
  ctx.font = `${TEXT_FONT_SIZE * dpr}px sans-serif`;
  ctx.textBaseline = "middle";
}

function getTextBounds(
  ctx: CanvasRenderingContext2D,
  anchor: ScreenPoint,
  text: string,
  dpr: number
) {
  applyTextFont(ctx, dpr);

  const width = ctx.measureText(text || "Text").width;
  const paddingX = TEXT_PADDING_X * dpr;
  const paddingY = TEXT_PADDING_Y * dpr;
  const height = TEXT_FONT_SIZE * dpr;

  return {
    left: anchor.x - paddingX,
    top: anchor.y - height / 2 - paddingY,
    width: width + paddingX * 2,
    height: height + paddingY * 2,
  };
}

function pointHitsBounds(
  point: ScreenPoint,
  bounds: { left: number; top: number; width: number; height: number },
  padding: number
): boolean {
  return (
    point.x >= bounds.left - padding &&
    point.x <= bounds.left + bounds.width + padding &&
    point.y >= bounds.top - padding &&
    point.y <= bounds.top + bounds.height + padding
  );
}

function getCandleAtOrBefore(data: Candle[], timestamp: number | null): Candle | null {
  if (timestamp === null || data.length === 0) return null;
  if (timestamp < data[0].time) return null;

  const index = findCandleIndexAtOrBefore(data, timestamp);
  const candle = data[index] ?? null;
  return candle && candle.time <= timestamp ? candle : null;
}

function drawReplayVerticalMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  height: number,
  color: string,
  label: string,
  dpr: number,
  dashed: boolean,
  offsetY = 8
) {
  const boxX = Math.min(x + 6 * dpr, Math.max(0, x));
  const boxY = offsetY * dpr;
  const boxWidth = 58 * dpr;
  const boxHeight = 18 * dpr;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25 * dpr;
  ctx.setLineDash(dashed ? [6 * dpr, 4 * dpr] : []);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  ctx.fillStyle = "#ffffff";
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxX + 8 * dpr, boxY + boxHeight / 2);
  ctx.restore();
}

function toChartCandle(candle: Candle): CandlestickData<Time> {
  return {
    ...candle,
    time: candle.time as UTCTimestamp,
  } as CandlestickData<Time>;
}

function getIncrementalLiveCandle(previous: Candle[], next: Candle[]): Candle | null {
  if (previous.length === 0 || next.length === 0) {
    return null;
  }

  if (next.length === previous.length) {
    if (previous[0]?.time !== next[0]?.time) {
      return null;
    }

    for (let index = 0; index < next.length - 1; index += 1) {
      if (previous[index] !== next[index]) {
        return null;
      }
    }

    return previous[previous.length - 1] === next[next.length - 1]
      ? null
      : next[next.length - 1] ?? null;
  }

  if (next.length === previous.length + 1) {
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== next[index]) {
        return null;
      }
    }

    return next[next.length - 1] ?? null;
  }

  return null;
}

export default function Chart({
  data,
  activeChart,
  setActiveChart,
  chartId,
  symbol,
  timeframe,
  drawings,
  onAddTrendline,
  onAddRectangle,
  onAddText,
  onDeleteDrawing,
  onUpdateDrawing,
  onPreviewDrawing,
  onCommitPreviewDrawing,
  tool,
  magnet = false,
  hidden = false,
  isReplay = false,
  isReplaySelectingStart = false,
  replaySelectionPanelId = null,
  replayStartTime = null,
  replayCursorTime = null,
  replayIndex = 0,
  isReplaySync = false,
  onReplayStart,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  showSessions = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const overlayFrameRef = useRef<number | null>(null);
  const initFrameRef = useRef<number | null>(null);
  const readyFrameRef = useRef<number | null>(null);
  const dataFitFrameRef = useRef<number | null>(null);
  const hasInitialData = useRef(false);
  const pendingInitialFitRef = useRef(false);
  const chartReadyRef = useRef(false);
  const activeChartRef = useRef<string | null>(null);
  const symbolRef = useRef(symbol);
  const timeframeRef = useRef(timeframe);
  const toolRef = useRef(tool);
  const magnetRef = useRef(magnet);
  const hiddenRef = useRef(hidden);
  const isReplayRef = useRef(isReplay);
  const isReplaySyncRef = useRef(isReplaySync);
  const isReplaySelectingForThisChart = Boolean(
    isReplaySelectingStart &&
      (isReplaySync || replaySelectionPanelId === chartId)
  );
  const isReplaySelectingForThisChartRef = useRef(isReplaySelectingForThisChart);
  const replayStartTimeRef = useRef(replayStartTime);
  const replayCursorTimeRef = useRef(replayCursorTime);
  const showSessionsRef = useRef(showSessions);
  const candleStoreDataRef = useRef<Record<string, Record<string, Candle[]>>>({});
  const dataRef = useRef(data);
  const displayedDataRef = useRef<Candle[]>(data);
  const drawingsRef = useRef(drawings);
  const selectedDrawingRef = useRef<DrawingSelection | null>(null);
  const onAddTrendlineRef = useRef(onAddTrendline);
  const onAddRectangleRef = useRef(onAddRectangle);
  const onAddTextRef = useRef(onAddText);
  const onDeleteDrawingRef = useRef(onDeleteDrawing);
  const onUpdateDrawingRef = useRef(onUpdateDrawing);
  const onPreviewDrawingRef = useRef(onPreviewDrawing);
  const onCommitPreviewDrawingRef = useRef(onCommitPreviewDrawing);
  const onReplayStartRef = useRef(onReplayStart);

  const drawStartRef = useRef<Point | null>(null);
  const drawPreviewRef = useRef<Point | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartPointRef = useRef<Point | null>(null);
  const dragStartScreenRef = useRef<ScreenPoint | null>(null);
  const dragInitialRef = useRef<Drawing | null>(null);
  const dragModeRef = useRef<DragMode>("move");
  const dragMovedRef = useRef(false);
  const suppressClickRef = useRef(false);

  const setTool = useToolStore((state) => state.setTool);
  const { theme } = useThemeStore();
  const candleStoreData = useCandleStore((state) => state.data);
  const [drawingStep, setDrawingStep] = useState<"none" | "started">("none");
  const [selectedDrawing, setSelectedDrawing] = useState<DrawingSelection | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const fullData: Candle[] = data.length > 0 ? data : candleStoreData[symbol]?.[timeframe] ?? [];
  const replayActiveForThisChart = Boolean(isReplay && (isReplaySync || activeChart === chartId));
  const hasNoEarlierReplayData = Boolean(
    replayActiveForThisChart &&
      replayStartTime !== null &&
      (fullData.length === 0 || replayStartTime < fullData[0].time)
  );

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    magnetRef.current = magnet;
  }, [magnet]);

  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);

  useEffect(() => {
    isReplayRef.current = isReplay;
  }, [isReplay]);

  useEffect(() => {
    isReplaySyncRef.current = isReplaySync;
  }, [isReplaySync]);

  useEffect(() => {
    isReplaySelectingForThisChartRef.current = isReplaySelectingForThisChart;
  }, [isReplaySelectingForThisChart]);

  useEffect(() => {
    replayStartTimeRef.current = replayStartTime;
  }, [replayStartTime]);

  useEffect(() => {
    replayCursorTimeRef.current = replayCursorTime;
  }, [replayCursorTime]);

  useEffect(() => {
    showSessionsRef.current = showSessions;
  }, [showSessions]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    candleStoreDataRef.current = candleStoreData;
  }, [candleStoreData]);

  useEffect(() => {
    activeChartRef.current = activeChart ?? null;
  }, [activeChart]);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);

  useEffect(() => {
    selectedDrawingRef.current = selectedDrawing;
  }, [selectedDrawing]);

  useEffect(() => {
    onAddTrendlineRef.current = onAddTrendline;
  }, [onAddTrendline]);

  useEffect(() => {
    onAddRectangleRef.current = onAddRectangle;
  }, [onAddRectangle]);

  useEffect(() => {
    onAddTextRef.current = onAddText;
  }, [onAddText]);

  useEffect(() => {
    onDeleteDrawingRef.current = onDeleteDrawing;
  }, [onDeleteDrawing]);

  useEffect(() => {
    onUpdateDrawingRef.current = onUpdateDrawing;
  }, [onUpdateDrawing]);

  useEffect(() => {
    onPreviewDrawingRef.current = onPreviewDrawing;
  }, [onPreviewDrawing]);

  useEffect(() => {
    onCommitPreviewDrawingRef.current = onCommitPreviewDrawing;
  }, [onCommitPreviewDrawing]);

  useEffect(() => {
    onReplayStartRef.current = onReplayStart;
  }, [onReplayStart]);

  const setChartReadyState = useCallback((ready: boolean) => {
    if (chartReadyRef.current === ready) return;

    chartReadyRef.current = ready;
    setChartReady(ready);
  }, []);

  const pointToScreen = useCallback((point: Point): ScreenPoint | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !chartReadyRef.current) return null;

    try {
      const dpr = window.devicePixelRatio || 1;
      const candles =
        dataRef.current.length > 0
          ? dataRef.current
          : candleStoreDataRef.current[symbolRef.current]?.[timeframeRef.current] ?? [];
      const y = series.priceToCoordinate(point.price);
      if (y === null) return null;

      let x = chart.timeScale().timeToCoordinate(point.time);

      if (x === null && candles.length > 0) {
        const lastIndex = candles.length - 1;
        const lastCandle = candles[lastIndex];
        const step = getTimeframeSeconds(timeframeRef.current);
        const candleOffset = (point.time - lastCandle.time) / step;
        const logical = lastIndex + candleOffset;
        x = chart.timeScale().logicalToCoordinate(logical as Logical);
      }

      if (x === null) return null;
      return { x: x * dpr, y: y * dpr };
    } catch {
      return null;
    }
  }, []);

  const hitTestDrawings = useCallback(
    (screenPoint: ScreenPoint): DrawingSelection | null => {
      if (hiddenRef.current) return null;

      const canvas = overlayRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const dpr = window.devicePixelRatio || 1;
      const threshold = 6 * dpr;

      for (let index = drawingsRef.current.texts.length - 1; index >= 0; index -= 1) {
        const text = drawingsRef.current.texts[index];
        const anchor = pointToScreen({ time: text.time, price: text.price });
        if (!anchor) continue;

        const bounds = getTextBounds(ctx, anchor, text.text, dpr);
        if (pointHitsBounds(screenPoint, bounds, 2 * dpr)) {
          return { type: "text", id: text.id };
        }
      }

      for (let index = drawingsRef.current.trendlines.length - 1; index >= 0; index -= 1) {
        const line = drawingsRef.current.trendlines[index];
        const start = pointToScreen(line.start);
        const end = pointToScreen(line.end);
        if (!start || !end) continue;

        const segment = getTrendlineSegment(
          start,
          end,
          line.extend,
          canvas.width,
          canvas.height
        );
        const targetStart = segment?.start ?? start;
        const targetEnd = segment?.end ?? end;

        if (distancePointToSegment(screenPoint, targetStart, targetEnd) <= threshold) {
          return { type: "trendline", id: line.id };
        }
      }

      for (let index = drawingsRef.current.rectangles.length - 1; index >= 0; index -= 1) {
        const rect = drawingsRef.current.rectangles[index];
        const start = pointToScreen(rect.start);
        const end = pointToScreen(rect.end);
        if (!start || !end) continue;

        if (pointHitsRectangle(screenPoint, start, end, threshold)) {
          return { type: "rectangle", id: rect.id };
        }
      }

      return null;
    },
    [pointToScreen]
  );

  const getDrawingBySelection = useCallback((selection: DrawingSelection | null) => {
    if (!selection) return null;

    if (selection.type === "trendline") {
      return drawingsRef.current.trendlines.find((line) => line.id === selection.id) ?? null;
    }

    if (selection.type === "rectangle") {
      return drawingsRef.current.rectangles.find((rect) => rect.id === selection.id) ?? null;
    }

    return drawingsRef.current.texts.find((text) => text.id === selection.id) ?? null;
  }, []);

  const hitTestSelectedHandles = useCallback(
    (screenPoint: ScreenPoint): DragTarget | null => {
      const selection = selectedDrawingRef.current;
      const drawing = getDrawingBySelection(selection);
      if (!selection || !drawing) return null;
      if (selection.type === "text" || !isPointDrawing(drawing)) return null;

      const threshold = 6 * (window.devicePixelRatio || 1);
      const start = pointToScreen(drawing.start);
      const end = pointToScreen(drawing.end);
      if (!start || !end) return null;

      if (selection.type === "rectangle") {
        if (isNearPoint(screenPoint, start, threshold)) {
          return { selection, dragMode: "resize-start" };
        }

        if (isNearPoint(screenPoint, end, threshold)) {
          return { selection, dragMode: "resize-end" };
        }

        const bounds = getRectangleBounds(start, end);

        if (
          distancePointToSegment(screenPoint, bounds.topLeft, bounds.bottomLeft) <= threshold
        ) {
          return { selection, dragMode: "resize-left" };
        }

        if (
          distancePointToSegment(screenPoint, bounds.topRight, bounds.bottomRight) <= threshold
        ) {
          return { selection, dragMode: "resize-right" };
        }

        if (
          distancePointToSegment(screenPoint, bounds.topLeft, bounds.topRight) <= threshold
        ) {
          return { selection, dragMode: "resize-top" };
        }

        if (
          distancePointToSegment(screenPoint, bounds.bottomLeft, bounds.bottomRight) <= threshold
        ) {
          return { selection, dragMode: "resize-bottom" };
        }

        return null;
      }

      if (isNearPoint(screenPoint, start, threshold)) {
        return { selection, dragMode: "resize-start" };
      }

      if (isNearPoint(screenPoint, end, threshold)) {
        return { selection, dragMode: "resize-end" };
      }

      return null;
    },
    [getDrawingBySelection, pointToScreen]
  );

  const getRectangleEdgeResizePoints = useCallback(
    (initial: Trendline | Rectangle, dragMode: DragMode, point: Point) => {
      const nextStart = { ...initial.start };
      const nextEnd = { ...initial.end };

      if (dragMode === "resize-left") {
        if (initial.start.time <= initial.end.time) {
          nextStart.time = point.time;
        } else {
          nextEnd.time = point.time;
        }
      } else if (dragMode === "resize-right") {
        if (initial.start.time >= initial.end.time) {
          nextStart.time = point.time;
        } else {
          nextEnd.time = point.time;
        }
      } else if (dragMode === "resize-top") {
        if (initial.start.price >= initial.end.price) {
          nextStart.price = point.price;
        } else {
          nextEnd.price = point.price;
        }
      } else if (dragMode === "resize-bottom") {
        if (initial.start.price <= initial.end.price) {
          nextStart.price = point.price;
        } else {
          nextEnd.price = point.price;
        }
      }

      return {
        start: nextStart,
        end: nextEnd,
      };
    },
    []
  );

  const hitTestDragTarget = useCallback(
    (screenPoint: ScreenPoint): DragTarget | null => {
      const handleHit = hitTestSelectedHandles(screenPoint);
      if (handleHit) return handleHit;

      const drawingHit = hitTestDrawings(screenPoint);
      if (!drawingHit) return null;

      return { selection: drawingHit, dragMode: "move" };
    },
    [hitTestDrawings, hitTestSelectedHandles]
  );

  const getAvailableCandles = useCallback((): Candle[] => {
    return dataRef.current.length > 0
      ? dataRef.current
      : candleStoreDataRef.current[symbolRef.current]?.[timeframeRef.current] ?? [];
  }, []);

  const pointFromCoordinates = useCallback((x: number, y: number): Point | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !chartReadyRef.current) return null;

    try {
      const candles = getAvailableCandles();
      const price = series.coordinateToPrice(y);
      if (price === null) return null;

      const timeFromCoordinate = chart.timeScale().coordinateToTime(x);
      if (typeof timeFromCoordinate === "number") {
        return { time: timeFromCoordinate as UTCTimestamp, price };
      }

      const logical = chart.timeScale().coordinateToLogical(x);
      const resolvedTime =
        typeof logical === "number"
          ? resolveTimeFromLogicalIndex(logical, candles, timeframeRef.current)
          : null;

      if (resolvedTime === null) return null;

      return { time: resolvedTime, price };
    } catch {
      return null;
    }
  }, [getAvailableCandles]);

  const getRawPointFromParam = useCallback((param: MouseEventParams<Time>): Point | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !chartReadyRef.current || !param.point) return null;

    try {
      const candles = getAvailableCandles();
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return null;

      const timeFromEvent = param.time;
      const timeFromCoord = chart.timeScale().coordinateToTime(param.point.x);
      const logical =
        typeof param.logical === "number"
          ? param.logical
          : chart.timeScale().coordinateToLogical(param.point.x);

      const time: number | null =
        typeof timeFromEvent === "number"
          ? timeFromEvent
          : typeof timeFromCoord === "number"
            ? timeFromCoord
            : typeof logical === "number"
              ? resolveTimeFromLogicalIndex(logical, candles, timeframeRef.current)
              : null;

      if (time === null) return null;

      return { time: time as UTCTimestamp, price };
    } catch {
      return null;
    }
  }, [getAvailableCandles]);

  const getNearestCandle = useCallback((param: MouseEventParams<Time>): Candle | null => {
    if (typeof param.logical !== "number") return null;

    const index = Math.round(param.logical);
    const candles = getAvailableCandles();
    if (index < 0 || index >= candles.length) return null;

    return candles[index] ?? null;
  }, [getAvailableCandles]);

  const applyMagnet = useCallback(
    (param: MouseEventParams<Time>, rawPoint: Point): Point => {
      if (!magnetRef.current) {
        return rawPoint;
      }

      const candles = getAvailableCandles();
      if (candles.length === 0) return rawPoint;

      const logical =
        typeof param.logical === "number"
          ? param.logical
          : param.point
            ? chartRef.current?.timeScale().coordinateToLogical(param.point.x)
            : null;
      if (typeof logical !== "number") return rawPoint;

      const nearestIndex = Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
      const candle = candles[nearestIndex];
      if (!candle) return rawPoint;

      const levels = [candle.open, candle.high, candle.low, candle.close];
      let closest = levels[0];

      for (const level of levels) {
        if (Math.abs(level - rawPoint.price) < Math.abs(closest - rawPoint.price)) {
          closest = level;
        }
      }

      return {
        time:
          logical < 0 || logical > candles.length - 1
            ? rawPoint.time
            : (candle.time as UTCTimestamp),
        price: closest,
      };
    },
    [getAvailableCandles]
  );

  const getSnappedPointFromParam = useCallback(
    (param: MouseEventParams<Time>): Point | null => {
      const rawPoint = getRawPointFromParam(param);
      if (!rawPoint) return null;

      return applyMagnet(param, rawPoint);
    },
    [applyMagnet, getRawPointFromParam]
  );

  const setContainerCursor = useCallback((cursor: string) => {
    if (containerRef.current) {
      containerRef.current.style.cursor = cursor;
    }
  }, []);

  const getDefaultCursor = useCallback(() => {
    if (isReplaySelectingForThisChartRef.current) return "crosshair";
    if (hiddenRef.current) return "";

    return toolRef.current === "trendline" ||
      toolRef.current === "rectangle" ||
      toolRef.current === "text"
      ? "crosshair"
      : "";
  }, []);

  const setPressedNavigationEnabled = useCallback((enabled: boolean) => {
    if (!chartRef.current) return;

    chartRef.current.applyOptions({
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: enabled,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: enabled,
          price: enabled,
        },
      },
    });
  }, []);

  const resetDragState = useCallback(() => {
    isDraggingRef.current = false;
    dragStartPointRef.current = null;
    dragStartScreenRef.current = null;
    dragInitialRef.current = null;
    dragModeRef.current = "move";
    dragMovedRef.current = false;
    setPressedNavigationEnabled(true);
    setContainerCursor(getDefaultCursor());
  }, [getDefaultCursor, setContainerCursor, setPressedNavigationEnabled]);

  const drawReplayOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number) => {
      const chart = chartRef.current;
      if (!chart) return;

      const currentData =
        dataRef.current.length > 0
          ? dataRef.current
          : candleStoreDataRef.current[symbolRef.current]?.[timeframeRef.current] ?? [];
      const replayActive = Boolean(
        isReplayRef.current &&
          (isReplaySyncRef.current || activeChartRef.current === chartId)
      );
      const replayStart = replayStartTimeRef.current;
      const replayCursor = replayCursorTimeRef.current;
      const hasNoEarlierData =
        replayActive &&
        replayStart !== null &&
        (currentData.length === 0 || replayStart < currentData[0].time);

      if (!replayActive || isReplaySelectingForThisChartRef.current || hasNoEarlierData) {
        return;
      }

      const timeScale = chart.timeScale();
      const accentColor =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--panel-accent")
          .trim() || "#4da3ff";
      const anchor = getCandleAtOrBefore(currentData, replayStart);
      const cursor = getCandleAtOrBefore(currentData, replayCursor);

      if (anchor) {
        const anchorX = timeScale.timeToCoordinate(anchor.time as UTCTimestamp);
        if (anchorX !== null) {
          drawReplayVerticalMarker(
            ctx,
            anchorX * dpr,
            canvas.height,
            "#f59e0b",
            "START",
            dpr,
            true,
            8
          );
        }
      }

      if (cursor) {
        const cursorX = timeScale.timeToCoordinate(cursor.time as UTCTimestamp);
        if (cursorX !== null) {
          drawReplayVerticalMarker(
            ctx,
            cursorX * dpr,
            canvas.height,
            accentColor,
            "NOW",
            dpr,
            false,
            anchor ? 30 : 8
          );
        }
      }
    },
    [chartId]
  );

  const drawSessionOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number) => {
      if (!showSessionsRef.current) {
        return;
      }

      const chart = chartRef.current;
      if (!chart) {
        return;
      }

      const visibleCandles = displayedDataRef.current;
      if (visibleCandles.length === 0) {
        return;
      }

      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (!logicalRange) {
        return;
      }

      const visibleFrom =
        resolveTimeFromLogicalIndex(logicalRange.from, visibleCandles, timeframeRef.current) ??
        (visibleCandles[0]?.time as UTCTimestamp | undefined);
      const visibleTo =
        resolveTimeFromLogicalIndex(logicalRange.to, visibleCandles, timeframeRef.current) ??
        (visibleCandles[visibleCandles.length - 1]?.time as UTCTimestamp | undefined);

      if (typeof visibleFrom !== "number" || typeof visibleTo !== "number") {
        return;
      }

      const rangeStart = Math.min(visibleFrom, visibleTo);
      const rangeEnd = Math.max(visibleFrom, visibleTo);
      const viewportWidth = canvas.width / dpr;
      const computedStyle = getComputedStyle(document.documentElement);
      const panelTextColor = computedStyle.getPropertyValue("--panel-text").trim() || "#e5e7eb";
      const panelBackground = computedStyle.getPropertyValue("--panel-bg").trim() || "#0f172a";

      const startDate = new Date(rangeStart * 1000);
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(rangeEnd * 1000);
      endDate.setUTCHours(0, 0, 0, 0);

      for (
        const day = new Date(startDate);
        day.getTime() <= endDate.getTime();
        day.setUTCDate(day.getUTCDate() + 1)
      ) {
        for (const session of SESSION_KEYS) {
          const config = SESSION_CONFIG[session];
          const sessionRange = getSessionRange(day, session);

          if (sessionRange.end <= rangeStart || sessionRange.start >= rangeEnd) {
            continue;
          }

          const startCoordinate = chart.timeScale().timeToCoordinate(
            sessionRange.start as UTCTimestamp
          );
          const endCoordinate = chart.timeScale().timeToCoordinate(
            sessionRange.end as UTCTimestamp
          );
          const startX =
            startCoordinate === null
              ? sessionRange.start < rangeStart
                ? 0
                : viewportWidth
              : (startCoordinate as unknown as number);
          const endX =
            endCoordinate === null
              ? sessionRange.end > rangeEnd
                ? viewportWidth
                : 0
              : (endCoordinate as unknown as number);

          const left = Math.max(0, Math.min(startX, endX));
          const right = Math.min(viewportWidth, Math.max(startX, endX));
          const width = right - left;

          if (width <= 1) {
            continue;
          }

          ctx.save();
          ctx.fillStyle = config.color;
          ctx.fillRect(left * dpr, 0, width * dpr, canvas.height);

          if (width >= 48) {
            const labelPaddingX = 6 * dpr;
            ctx.font = `${10 * dpr}px sans-serif`;
            const labelWidth = ctx.measureText(config.label).width + labelPaddingX * 2;
            const maxLabelWidth = width * dpr - 8 * dpr;

            if (maxLabelWidth > labelWidth) {
              ctx.globalAlpha = 0.82;
              ctx.fillStyle = panelBackground;
              ctx.fillRect(left * dpr + 4 * dpr, 6 * dpr, labelWidth, 18 * dpr);
              ctx.globalAlpha = 1;
              ctx.fillStyle = panelTextColor;
              ctx.textBaseline = "middle";
              ctx.fillText(
                config.label,
                left * dpr + 4 * dpr + labelPaddingX,
                15 * dpr
              );
            }
          }

          ctx.restore();
        }
      }
    },
    []
  );

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || !chartReadyRef.current) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawSessionOverlay(ctx, canvas, dpr);

    if (hiddenRef.current) {
      drawReplayOverlay(ctx, canvas, dpr);
      return;
    }

    ctx.save();
    ctx.lineCap = "round";

    for (const line of drawingsRef.current.trendlines) {
      const start = pointToScreen(line.start);
      const end = pointToScreen(line.end);
      if (!start || !end) continue;

      const extended = getTrendlineSegment(
        start,
        end,
        line.extend,
        canvas.width,
        canvas.height
      );
      if (!extended) continue;

      const isSelected =
        selectedDrawingRef.current?.type === "trendline" &&
        selectedDrawingRef.current.id === line.id;

      const color = line.color || theme.accent;
      const width = line.width || 2;
      const opacity = line.opacity ?? 1;

      ctx.globalAlpha = opacity;
      ctx.strokeStyle = isSelected ? "#ffffff" : color;
      ctx.lineWidth = (isSelected ? 3 : width) * dpr;
      ctx.beginPath();
      ctx.moveTo(extended.start.x, extended.start.y);
      ctx.lineTo(extended.end.x, extended.end.y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (isSelected) {
        ctx.fillStyle = "#ffffff";
        drawSelectionHandle(ctx, start, 4 * dpr);
        drawSelectionHandle(ctx, end, 4 * dpr);
      }
    }

    if (toolRef.current === "trendline" && drawStartRef.current && drawPreviewRef.current) {
      const start = pointToScreen(drawStartRef.current);
      const end = pointToScreen(drawPreviewRef.current);
      if (start && end) {
        const extended = getTrendlineSegment(
          start,
          end,
          DEFAULT_TRENDLINE_EXTENSION,
          canvas.width,
          canvas.height
        );
        if (extended) {
          const accentColor = getComputedStyle(document.documentElement)
            .getPropertyValue("--panel-accent")
            .trim();
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 2 * dpr;
          ctx.setLineDash([6 * dpr, 4 * dpr]);
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(extended.start.x, extended.start.y);
          ctx.lineTo(extended.end.x, extended.end.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 2 * dpr;

    for (const rect of drawingsRef.current.rectangles) {
      const start = pointToScreen(rect.start);
      const end = pointToScreen(rect.end);
      if (!start || !end) continue;

      const isSelected =
        selectedDrawingRef.current?.type === "rectangle" &&
        selectedDrawingRef.current.id === rect.id;
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const rectWidth = Math.abs(end.x - start.x);
      const rectHeight = Math.abs(end.y - start.y);

      const color = rect.color || "#f5a623";
      const rwidth = rect.width || 2;
      const opacity = rect.opacity ?? 1;

      ctx.globalAlpha = opacity;
      ctx.strokeStyle = isSelected ? "#ffffff" : color;
      ctx.fillStyle = isSelected ? "rgba(255, 255, 255, 0.12)" : "rgba(245, 166, 35, 0.15)";
      ctx.lineWidth = (isSelected ? 3 : rwidth) * dpr;
      ctx.beginPath();
      ctx.rect(x, y, rectWidth, rectHeight);
      ctx.fill();
      ctx.stroke();

      if (isSelected) {
        ctx.fillStyle = "#ffffff";
        drawSelectionHandle(ctx, start, 4 * dpr);
        drawSelectionHandle(ctx, end, 4 * dpr);
      }
    }

    applyTextFont(ctx, dpr);

    for (const text of drawingsRef.current.texts) {
      const anchor = pointToScreen({ time: text.time, price: text.price });
      if (!anchor) continue;

      const isSelected =
        selectedDrawingRef.current?.type === "text" &&
        selectedDrawingRef.current.id === text.id;
      const bounds = getTextBounds(ctx, anchor, text.text, dpr);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(text.text || "Text", anchor.x, anchor.y);

      if (isSelected) {
        const accentColor = getComputedStyle(document.documentElement)
          .getPropertyValue("--panel-accent")
          .trim();
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeRect(bounds.left, bounds.top, bounds.width, bounds.height);
      }
    }

    if (toolRef.current === "rectangle" && drawStartRef.current && drawPreviewRef.current) {
      const start = pointToScreen(drawStartRef.current);
      const end = pointToScreen(drawPreviewRef.current);
      if (start && end) {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);

        ctx.strokeStyle = "#f5a623";
        ctx.fillStyle = "rgba(245, 166, 35, 0.15)";
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    drawReplayOverlay(ctx, canvas, dpr);
  }, [drawReplayOverlay, drawSessionOverlay, pointToScreen]);

  const scheduleOverlayDraw = useCallback(() => {
    if (overlayFrameRef.current !== null) return;

    overlayFrameRef.current = window.requestAnimationFrame(() => {
      overlayFrameRef.current = null;
      drawOverlay();
    });
  }, [drawOverlay]);

  const syncOverlaySize = useCallback(() => {
    const canvas = overlayRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width <= 0 || height <= 0) {
      setChartReadyState(false);
      return;
    }

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    setChartReadyState(true);
    scheduleOverlayDraw();
  }, [scheduleOverlayDraw, setChartReadyState]);

  const clearDrawing = useCallback(() => {
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    scheduleOverlayDraw();
  }, [scheduleOverlayDraw]);

  const clearSelectedDrawing = useCallback(() => {
    selectedDrawingRef.current = null;
    setSelectedDrawing(null);
  }, []);

  const applyPreviewDrawingUpdate = useCallback(
    (selection: DrawingSelection, nextDrawing: Drawing) => {
      if (onPreviewDrawingRef.current) {
        onPreviewDrawingRef.current(selection, nextDrawing);
        return;
      }

      onUpdateDrawingRef.current?.(selection, nextDrawing);
    },
    []
  );

  const cancelTransientInteraction = useCallback(() => {
    let cancelled = false;

    const selection = selectedDrawingRef.current;
    const initialDrawing = dragInitialRef.current;
    if (isDraggingRef.current && selection && initialDrawing) {
      applyPreviewDrawingUpdate(selection, initialDrawing);
      cancelled = true;
    }

    if (isDraggingRef.current) {
      resetDragState();
      suppressClickRef.current = false;
      cancelled = true;
    }

    if (drawStartRef.current || drawPreviewRef.current) {
      drawStartRef.current = null;
      drawPreviewRef.current = null;
      setDrawingStep("none");
      cancelled = true;
    }

    if (cancelled) {
      scheduleOverlayDraw();
    }

    return cancelled;
  }, [applyPreviewDrawingUpdate, resetDragState, scheduleOverlayDraw]);

  useEffect(() => {
    clearDrawing();
    setDrawingStep("none");
  }, [tool, clearDrawing]);

  useEffect(() => {
    if (!isReplaySelectingForThisChart) return;

    cancelTransientInteraction();
    clearSelectedDrawing();
    scheduleOverlayDraw();
  }, [
    cancelTransientInteraction,
    clearSelectedDrawing,
    isReplaySelectingForThisChart,
    scheduleOverlayDraw,
  ]);

  useEffect(() => {
    if (!hidden) {
      setContainerCursor(getDefaultCursor());
      scheduleOverlayDraw();
      return;
    }

    cancelTransientInteraction();
    clearSelectedDrawing();
    scheduleOverlayDraw();
  }, [
    cancelTransientInteraction,
    clearSelectedDrawing,
    getDefaultCursor,
    hidden,
    scheduleOverlayDraw,
    setContainerCursor,
  ]);

  useEffect(() => {
    hasInitialData.current = false;
    cancelTransientInteraction();
    clearSelectedDrawing();
    scheduleOverlayDraw();
  }, [cancelTransientInteraction, clearSelectedDrawing, scheduleOverlayDraw, symbol, timeframe]);

  useEffect(() => {
    if (activeChart && activeChart !== chartId && selectedDrawingRef.current) {
      cancelTransientInteraction();
      clearSelectedDrawing();
    }
  }, [activeChart, cancelTransientInteraction, chartId, clearSelectedDrawing]);

  useEffect(() => {
    if (!selectedDrawing && isDraggingRef.current) {
      resetDragState();
    }
  }, [selectedDrawing, resetDragState]);

  useEffect(() => {
    if (!selectedDrawing) return;

    const exists =
      selectedDrawing.type === "trendline"
        ? drawings.trendlines.some((line) => line.id === selectedDrawing.id)
        : selectedDrawing.type === "rectangle"
          ? drawings.rectangles.some((rect) => rect.id === selectedDrawing.id)
          : drawings.texts.some((text) => text.id === selectedDrawing.id);

    if (!exists) {
      setSelectedDrawing(null);
    }
  }, [drawings, selectedDrawing]);

  useEffect(() => {
    scheduleOverlayDraw();
  }, [selectedDrawing, scheduleOverlayDraw]);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setContainerCursor(getDefaultCursor());
    }
  }, [getDefaultCursor, isReplaySelectingForThisChart, setContainerCursor, tool]);

  useEffect(() => {
    if (!chartRef.current) return;

    chartRef.current.applyOptions({
      layout: {
        background: { color: theme.background },
        textColor: theme.text,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
    });

    if (seriesRef.current) {
      seriesRef.current.applyOptions({
        upColor: theme.candleUp,
        downColor: theme.candleDown,
        borderUpColor: theme.candleUp,
        borderDownColor: theme.candleDown,
        wickUpColor: theme.wickUp,
        wickDownColor: theme.wickDown,
      });
    }

    scheduleOverlayDraw();
  }, [theme, scheduleOverlayDraw]);

  useEffect(() => {
    if (readyFrameRef.current !== null) {
      window.cancelAnimationFrame(readyFrameRef.current);
      readyFrameRef.current = null;
    }

    if (!chartReady) return;

    readyFrameRef.current = window.requestAnimationFrame(() => {
      readyFrameRef.current = null;
      if (!chartRef.current || !chartReadyRef.current) return;

      if (pendingInitialFitRef.current) {
        pendingInitialFitRef.current = false;
        hasInitialData.current = true;
        chartRef.current.timeScale().fitContent();
      }

      scheduleOverlayDraw();
    });

    return () => {
      if (readyFrameRef.current !== null) {
        window.cancelAnimationFrame(readyFrameRef.current);
        readyFrameRef.current = null;
      }
    };
  }, [chartReady, scheduleOverlayDraw]);

  useEffect(() => {
    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;

      const didMove = dragMovedRef.current;
      const selection = selectedDrawingRef.current;
      const initialDrawing = dragInitialRef.current;
      const currentDrawing = getDrawingBySelection(selection);

      if (didMove) {
        suppressClickRef.current = true;
      }

      if (didMove && selection && initialDrawing && currentDrawing) {
        onCommitPreviewDrawingRef.current?.(selection, initialDrawing, currentDrawing);
      }

      resetDragState();
    };

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [getDrawingBySelection, resetDragState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeChartRef.current !== chartId) return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      const metaOrCtrl = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (
        metaOrCtrl &&
        ((event.shiftKey && key === "z") || key === "y")
      ) {
        if (isDraggingRef.current || drawStartRef.current) {
          if (cancelTransientInteraction()) {
            event.preventDefault();
          }
          return;
        }

        if (!canRedo) return;
        event.preventDefault();
        onRedo?.();
        return;
      }

      if (metaOrCtrl && !event.shiftKey && key === "z") {
        if (isDraggingRef.current || drawStartRef.current) {
          if (cancelTransientInteraction()) {
            event.preventDefault();
          }
          return;
        }

        if (!canUndo) return;
        event.preventDefault();
        onUndo?.();
        return;
      }

      if (event.key === "Escape") {
        if (cancelTransientInteraction()) {
          event.preventDefault();
          return;
        }

        if (!selectedDrawingRef.current) return;

        clearSelectedDrawing();
        scheduleOverlayDraw();
        event.preventDefault();
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") return;

      const currentSelection = selectedDrawingRef.current;
      if (!currentSelection) return;

      onDeleteDrawingRef.current?.(currentSelection.id);
      clearSelectedDrawing();
      event.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cancelTransientInteraction,
    canRedo,
    canUndo,
    chartId,
    clearSelectedDrawing,
    onRedo,
    onUndo,
    scheduleOverlayDraw,
  ]);

  useEffect(() => {
    return () => {
      resetDragState();
    };
  }, [resetDragState]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    hasInitialData.current = false;
    pendingInitialFitRef.current = false;
    setChartReadyState(false);
    resetDragState();
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    setDrawingStep("none");

    const initialWidth = Math.max(container.clientWidth, 1);
    const initialHeight = Math.max(container.clientHeight, 1);

    const chart = createChart(container, {
      width: initialWidth,
      height: initialHeight,
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
      },
      layout: {
        background: { color: theme.background },
        textColor: theme.text,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
    });

    const series = chart.addCandlestickSeries({
      upColor: theme.candleUp,
      downColor: theme.candleDown,
      borderUpColor: theme.candleUp,
      borderDownColor: theme.candleDown,
      wickUpColor: theme.wickUp,
      wickDownColor: theme.wickDown,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleMouseDown = (event: MouseEvent) => {
      setActiveChart?.(chartId);
      activeChartRef.current = chartId;

      if (isReplaySelectingForThisChartRef.current) {
        return;
      }

      if (hiddenRef.current) {
        return;
      }

      const bounds = container.getBoundingClientRect();
      const localX = event.clientX - bounds.left;
      const localY = event.clientY - bounds.top;
      const point = pointFromCoordinates(localX, localY);
      if (!point) return;

      const dpr = window.devicePixelRatio || 1;
      const dragTarget = hitTestDragTarget({ x: localX * dpr, y: localY * dpr });
      if (!dragTarget) {
        return;
      }

      const drawing = getDrawingBySelection(dragTarget.selection);
      if (!drawing) return;

      selectedDrawingRef.current = dragTarget.selection;
      setSelectedDrawing(dragTarget.selection);
      isDraggingRef.current = true;
      dragStartPointRef.current = point;
      dragStartScreenRef.current = { x: localX * dpr, y: localY * dpr };
      dragInitialRef.current = isPointDrawing(drawing)
        ? {
            ...drawing,
            start: { ...drawing.start },
            end: { ...drawing.end },
          }
        : { ...drawing };
      dragModeRef.current = dragTarget.dragMode;
      dragMovedRef.current = false;
      setPressedNavigationEnabled(false);
      setContainerCursor(
        dragTarget.dragMode === "move" ? "grabbing" : getDragModeCursor(dragTarget.dragMode)
      );
      event.preventDefault();
    };
    container.addEventListener("mousedown", handleMouseDown);

    const handleDoubleClick = (event: MouseEvent) => {
      setActiveChart?.(chartId);
      activeChartRef.current = chartId;

      if (hiddenRef.current) {
        return;
      }

      const bounds = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const screenPoint = {
        x: (event.clientX - bounds.left) * dpr,
        y: (event.clientY - bounds.top) * dpr,
      };
      const hit = hitTestDrawings(screenPoint);
      if (!hit || hit.type !== "text") return;

      const drawing = getDrawingBySelection(hit);
      if (!drawing || !isTextDrawing(drawing)) return;

      setSelectedDrawing(hit);
      const nextText = window.prompt("Edit text:", drawing.text);
      if (nextText === null) {
        scheduleOverlayDraw();
        return;
      }

      onUpdateDrawingRef.current?.(hit, {
        ...drawing,
        text: nextText.trim() || "Text",
      });
      scheduleOverlayDraw();
      event.preventDefault();
    };
    container.addEventListener("dblclick", handleDoubleClick);

    chart.resize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
    syncOverlaySize();

    initFrameRef.current = window.requestAnimationFrame(() => {
      initFrameRef.current = null;
      if (chartRef.current !== chart) return;

      chart.resize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
      syncOverlaySize();
      scheduleOverlayDraw();
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.resize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
      syncOverlaySize();
    });
    resizeObserver.observe(container);

    const handleVisibleRangeChange = () => {
      scheduleOverlayDraw();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      try {
        const rawPoint = getRawPointFromParam(param);
        const snappedPoint = getSnappedPointFromParam(param);

        if (isReplaySelectingForThisChartRef.current) {
          if (!isDraggingRef.current) {
            setContainerCursor("crosshair");
          }
          return;
        }

        if (hiddenRef.current) {
          if (!isDraggingRef.current) {
            setContainerCursor(getDefaultCursor());
          }
          return;
        }

        if (
          isDraggingRef.current &&
          dragStartPointRef.current &&
          dragStartScreenRef.current &&
          dragInitialRef.current &&
          selectedDrawingRef.current &&
          param.point &&
          rawPoint
        ) {
          const dpr = window.devicePixelRatio || 1;
          const currentScreen = {
            x: param.point.x * dpr,
            y: param.point.y * dpr,
          };
          const movedEnough =
            Math.hypot(
              currentScreen.x - dragStartScreenRef.current.x,
              currentScreen.y - dragStartScreenRef.current.y
            ) >= 3 * dpr;

          if (!movedEnough) {
            return;
          }

          dragMovedRef.current = true;

          const initial = dragInitialRef.current;
          const selection = selectedDrawingRef.current;
          if (!initial) return;

          if (dragModeRef.current === "move") {
            const dx = rawPoint.time - dragStartPointRef.current.time;
            const dy = rawPoint.price - dragStartPointRef.current.price;
            if (selection.type === "text" && isTextDrawing(initial)) {
              applyPreviewDrawingUpdate(selection, {
                ...initial,
                time: (initial.time + dx) as UTCTimestamp,
                price: initial.price + dy,
              });
            } else if (isPointDrawing(initial)) {
              applyPreviewDrawingUpdate(selection, {
                ...initial,
                start: {
                  time: (initial.start.time + dx) as UTCTimestamp,
                  price: initial.start.price + dy,
                },
                end: {
                  time: (initial.end.time + dx) as UTCTimestamp,
                  price: initial.end.price + dy,
                },
              });
            }
          } else if (dragModeRef.current === "resize-start" && snappedPoint && isPointDrawing(initial)) {
            applyPreviewDrawingUpdate(selection, {
              ...initial,
              start: snappedPoint,
              end: initial.end,
            });
          } else if (
            selection.type === "rectangle" &&
            (dragModeRef.current === "resize-left" ||
              dragModeRef.current === "resize-right" ||
              dragModeRef.current === "resize-top" ||
              dragModeRef.current === "resize-bottom") &&
            snappedPoint &&
            isPointDrawing(initial)
          ) {
            applyPreviewDrawingUpdate(
              selection,
              {
                ...initial,
                ...getRectangleEdgeResizePoints(initial, dragModeRef.current, snappedPoint),
              }
            );
          } else if (snappedPoint && isPointDrawing(initial)) {
            applyPreviewDrawingUpdate(selection, {
              ...initial,
              start: initial.start,
              end: snappedPoint,
            });
          }
          return;
        }

        if (!isDraggingRef.current) {
          if (!param.point) {
            setContainerCursor(getDefaultCursor());
          } else {
            const dpr = window.devicePixelRatio || 1;
            const screenPoint = {
              x: param.point.x * dpr,
              y: param.point.y * dpr,
            };

            const handleHit = hitTestSelectedHandles(screenPoint);

            if (handleHit) {
              setContainerCursor(getDragModeCursor(handleHit.dragMode));
            } else if (hitTestDrawings(screenPoint)) {
              setContainerCursor("grab");
            } else {
              setContainerCursor(getDefaultCursor());
            }
          }
        }

        if ((toolRef.current === "trendline" || toolRef.current === "rectangle") && drawStartRef.current && snappedPoint) {
          drawPreviewRef.current = snappedPoint;
          scheduleOverlayDraw();
        }
      } catch (error) {
        console.error("[Chart] crosshairMove error:", error);
      }
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const handleClick = (param: MouseEventParams<Time>) => {
      try {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }

        if (!param.point) return;

        setActiveChart?.(chartId);
        activeChartRef.current = chartId;

        if (isReplaySelectingForThisChartRef.current) {
          const nearestCandle = getNearestCandle(param);
          const rawPoint = getRawPointFromParam(param);
          const timestamp =
            nearestCandle?.time ??
            (typeof rawPoint?.time === "number" ? Number(rawPoint.time) : null);

          if (timestamp !== null) {
            onReplayStartRef.current?.({
              panelId: chartId,
              symbol: symbolRef.current,
              timeframe: timeframeRef.current,
              timestamp,
            });
          }
          return;
        }

        if (hiddenRef.current) {
          scheduleOverlayDraw();
          return;
        }

        const dpr = window.devicePixelRatio || 1;
        const screenPoint = {
          x: param.point.x * dpr,
          y: param.point.y * dpr,
        };

        const hit = hitTestDrawings(screenPoint);
        if (hit) {
          drawStartRef.current = null;
          drawPreviewRef.current = null;
          setDrawingStep("none");
          setSelectedDrawing(hit);
          scheduleOverlayDraw();
          return;
        }

        if (selectedDrawingRef.current) {
          setSelectedDrawing(null);
        }

        const currentTool = toolRef.current;
        if (currentTool === "text") {
          const point = getSnappedPointFromParam(param);
          if (!point) return;

          const enteredText = window.prompt("Text:", "Text");
          if (enteredText === null) {
            scheduleOverlayDraw();
            return;
          }

          const text: TextDrawing = {
            type: "text",
            id: createDrawingId("text"),
            time: point.time,
            price: point.price,
            text: enteredText.trim() || "Text",
            color: theme.accent,
            width: 1,
            opacity: 1,
          };
          onAddTextRef.current(text);
          setSelectedDrawing({ type: "text", id: text.id });
          scheduleOverlayDraw();
          setTool("none");
          return;
        }

        if (currentTool !== "trendline" && currentTool !== "rectangle") {
          scheduleOverlayDraw();
          return;
        }

        const point = getSnappedPointFromParam(param);
        if (!point) return;

        if (!drawStartRef.current) {
          drawStartRef.current = point;
          drawPreviewRef.current = point;
          setDrawingStep("started");
          scheduleOverlayDraw();
          return;
        }

        const start = drawStartRef.current;

        if (currentTool === "trendline") {
          if (point.time === start.time) return;

          const line: Trendline = {
            type: "trendline",
            id: createDrawingId("trendline"),
            start,
            end: point,
            extend: DEFAULT_TRENDLINE_EXTENSION,
            color: theme.accent,
            width: 2,
            opacity: 1,
          };
          onAddTrendlineRef.current(line);
          setSelectedDrawing({ type: "trendline", id: line.id });
        } else {
          const rect: Rectangle = {
            type: "rectangle",
            id: createDrawingId("rectangle"),
            start,
            end: point,
            color: "#f5a623",
            width: 2,
            opacity: 1,
          };
          onAddRectangleRef.current(rect);
          setSelectedDrawing({ type: "rectangle", id: rect.id });
        }

        drawStartRef.current = null;
        drawPreviewRef.current = null;
        setDrawingStep("none");
        scheduleOverlayDraw();
        setTool("none");
      } catch (error) {
        console.error("[Chart] click error:", error);
        drawStartRef.current = null;
        drawPreviewRef.current = null;
        setDrawingStep("none");
        scheduleOverlayDraw();
      }
    };
    chart.subscribeClick(handleClick);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("dblclick", handleDoubleClick);
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

      if (overlayFrameRef.current !== null) {
        window.cancelAnimationFrame(overlayFrameRef.current);
      }

      if (initFrameRef.current !== null) {
        window.cancelAnimationFrame(initFrameRef.current);
        initFrameRef.current = null;
      }

      if (readyFrameRef.current !== null) {
        window.cancelAnimationFrame(readyFrameRef.current);
        readyFrameRef.current = null;
      }

      if (dataFitFrameRef.current !== null) {
        window.cancelAnimationFrame(dataFitFrameRef.current);
        dataFitFrameRef.current = null;
      }

      resizeObserver.disconnect();
      chart.remove();
      setChartReadyState(false);
      resetDragState();

      if (chartRef.current === chart) chartRef.current = null;
      if (seriesRef.current === series) seriesRef.current = null;
    };
  }, [
    chartId,
    getDefaultCursor,
    getDrawingBySelection,
    getNearestCandle,
    getRectangleEdgeResizePoints,
    getRawPointFromParam,
    getSnappedPointFromParam,
    hitTestDragTarget,
    hitTestDrawings,
    hitTestSelectedHandles,
    pointFromCoordinates,
    resetDragState,
    scheduleOverlayDraw,
    setActiveChart,
    setContainerCursor,
    setChartReadyState,
    setPressedNavigationEnabled,
    setTool,
    syncOverlaySize,
  ]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    // LIVE DATA LEAK FIX: Prevent inactive charts from updating during independent replay
    try {
      // Priority: use live data if available, otherwise fallback to historical from store
      const candlesFromStore = candleStoreData[symbol]?.[timeframe] ?? [];
      let displayData: Candle[] = data.length > 0
        ? data
        : candlesFromStore;

      // When replay selection is armed, keep the full chart visible so the user can pick any candle.
      const shouldApplyReplay =
        isReplay &&
        !isReplaySelectingForThisChart &&
        !hasNoEarlierReplayData &&
        (isReplaySync
          ? replayCursorTime !== null
          : activeChart === chartId);

      if (shouldApplyReplay && displayData.length > 0) {
        if (isReplaySync && replayCursorTime !== null) {
          const replayEndIndex = findCandleIndexAtOrBefore(displayData, replayCursorTime);
          displayData = displayData.slice(0, replayEndIndex + 1);
        } else {
          const safeIndex = Math.max(0, Math.min(replayIndex, displayData.length - 1));
          displayData = displayData.slice(0, safeIndex + 1);
        }
      }

      const incrementalLiveCandle = shouldApplyReplay
        ? null
        : getIncrementalLiveCandle(displayedDataRef.current, displayData);

      displayedDataRef.current = displayData;

      if (incrementalLiveCandle) {
        seriesRef.current.update(toChartCandle(incrementalLiveCandle));
      } else {
        seriesRef.current.setData(displayData.map(toChartCandle));
      }

      if (!hasInitialData.current && displayData.length > 0) {
        if (chartReadyRef.current) {
          hasInitialData.current = true;
          if (dataFitFrameRef.current !== null) {
            window.cancelAnimationFrame(dataFitFrameRef.current);
          }

          dataFitFrameRef.current = window.requestAnimationFrame(() => {
            dataFitFrameRef.current = null;
            if (!chartReadyRef.current) return;

            chartRef.current?.timeScale().fitContent();
            scheduleOverlayDraw();
          });
        } else {
          pendingInitialFitRef.current = true;
        }
      }

      scheduleOverlayDraw();
    } catch (error) {
      console.error("[Chart] setData error:", error);
    }
  }, [
    activeChart,
    candleStoreData,
    chartId,
    data,
    hasNoEarlierReplayData,
    isReplay,
    isReplaySelectingForThisChart,
    isReplaySync,
    replayCursorTime,
    replayIndex,
    replayStartTime,
    scheduleOverlayDraw,
    symbol,
    timeframe,
  ]);

  useEffect(() => {
    scheduleOverlayDraw();
  }, [drawings, scheduleOverlayDraw]);

  useEffect(() => {
    scheduleOverlayDraw();
  }, [scheduleOverlayDraw, showSessions]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="chart-canvas" />

      <canvas
        ref={overlayRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          pointerEvents: "none",
          zIndex: 5,
        }}
      />

      {isReplay && replayStartTime !== null && !isReplaySelectingForThisChart && (
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            zIndex: 10,
            pointerEvents: "none",
            minWidth: "220px",
            padding: "8px 10px",
            borderRadius: "8px",
            background: "rgba(19, 21, 26, 0.92)",
            border: "1px solid var(--panel-border)",
            color: "var(--panel-text)",
            fontSize: "11px",
            lineHeight: 1.5,
            boxShadow: "0 8px 18px rgba(0, 0, 0, 0.24)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "4px",
            }}
          >
            <strong
              style={{
                color: replayActiveForThisChart ? "var(--panel-accent)" : "var(--panel-muted)",
              }}
            >
              {replayActiveForThisChart ? "Replay Active" : "Replay Idle"}
            </strong>
            <span style={{ color: "var(--panel-muted)" }}>
              {symbol.toUpperCase()} · {timeframe}
            </span>
          </div>

          <div>
            <span style={{ color: "var(--panel-muted)" }}>Start: </span>
            <span>{formatReplayTime(replayStartTime)}</span>
          </div>

          <div>
            <span style={{ color: "var(--panel-muted)" }}>Now: </span>
            <span>{formatReplayTime(replayCursorTime)}</span>
          </div>

          {isReplaySync && (
            <div style={{ color: "var(--panel-muted)", marginTop: "2px" }}>
              Sync: timestamp-linked
            </div>
          )}
        </div>
      )}

      {hidden && !isReplaySelectingForThisChart && (
        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            padding: "4px 12px",
            background: "rgba(32, 34, 40, 0.8)",
            color: "#d4d7de",
            fontSize: "11px",
            borderRadius: "3px",
            fontWeight: "500",
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          Drawings hidden for this symbol
        </div>
      )}

      {isReplay && isReplaySelectingForThisChart && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 11,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(8, 10, 14, 0.08)",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "10px",
              background:
                theme.mode === "light"
                  ? "rgba(17, 24, 39, 0.88)"
                  : "rgba(19, 21, 26, 0.94)",
              border:
                theme.mode === "light"
                  ? "1px solid rgba(0, 0, 0, 0.08)"
                  : "1px solid var(--panel-border)",
              color: "#ffffff",
              fontSize: "12px",
              fontWeight: 600,
              boxShadow: "0 8px 20px rgba(0,0,0,0.22)",
            }}
          >
            Click a candle to set replay start
          </div>
        </div>
      )}

      {isReplay && !isReplaySelectingForThisChart && hasNoEarlierReplayData && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 12,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(8, 10, 14, 0.20)",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderRadius: "10px",
              background: "rgba(28, 31, 38, 0.95)",
              border: "1px solid rgba(239, 83, 80, 0.35)",
              color: "#ef5350",
              fontSize: "12px",
              fontWeight: 600,
              textAlign: "center",
              boxShadow: "0 8px 20px rgba(0,0,0,0.24)",
            }}
          >
            No earlier data for this panel
            <div
              style={{
                marginTop: "6px",
                color: "var(--panel-muted)",
                fontWeight: 400,
                fontSize: "11px",
              }}
            >
              Choose a later replay start or load more history
            </div>
          </div>
        </div>
      )}

      {!isReplaySelectingForThisChart &&
        !hidden &&
        (tool === "trendline" || tool === "rectangle") && (
        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            padding: "4px 12px",
            background:
              drawingStep === "started"
                ? tool === "rectangle"
                  ? "#f5a623"
                  : "var(--panel-accent)"
                : tool === "rectangle"
                  ? "rgba(245, 166, 35, 0.3)"
                  : "color-mix(in srgb, var(--panel-accent) 30%, transparent)",
            color: "#fff",
            fontSize: "11px",
            borderRadius: "3px",
            fontWeight: "500",
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          {drawingStep === "none" && (tool === "rectangle" ? "Click to draw rectangle" : "Click to draw trendline")}
          {drawingStep === "started" && (tool === "rectangle" ? "Click opposite corner to finish" : "Click another point to finish")}
        </div>
      )}

      {!isReplaySelectingForThisChart && !hidden && tool === "text" && (
        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            padding: "4px 12px",
            background: "rgba(125, 139, 160, 0.35)",
            color: "#fff",
            fontSize: "11px",
            borderRadius: "3px",
            fontWeight: "500",
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          Click to place text
        </div>
      )}

      {selectedDrawing &&
        (() => {
          let currentDrawing: Drawing | undefined;
          if (selectedDrawing.type === "trendline") {
            currentDrawing = drawingsRef.current.trendlines.find((line) => line.id === selectedDrawing.id);
          } else if (selectedDrawing.type === "rectangle") {
            currentDrawing = drawingsRef.current.rectangles.find((rect) => rect.id === selectedDrawing.id);
          } else if (selectedDrawing.type === "text") {
            currentDrawing = drawingsRef.current.texts.find((text) => text.id === selectedDrawing.id);
          }
          return currentDrawing ? (
            <DrawingStylePanel
              drawing={currentDrawing}
              onUpdate={(patch) => {
                if (onUpdateDrawingRef.current) {
                  onUpdateDrawingRef.current(selectedDrawing, {
                    ...currentDrawing,
                    ...patch,
                  });
                }
              }}
            />
          ) : null;
        })()}
    </div>
  );
}
