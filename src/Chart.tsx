import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  CrosshairMode,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useToolStore } from "./store/useToolStore";
import { useThemeStore } from "./store/useThemeStore";
import { useCandleStore } from "./store/useCandleStore";
import DrawingStylePanel from "./components/DrawingStylePanel";
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
} from "./types/drawings";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Props = {
  data: Candle[];
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  chartId: string;
  seriesKey: string;
  drawings: ChartDrawings;
  onAddTrendline: (chartId: string, line: Trendline) => void;
  onAddRectangle: (chartId: string, rect: Rectangle) => void;
  onAddText: (chartId: string, text: TextDrawing) => void;
  onDeleteDrawing?: (id: string) => void;
  onUpdateDrawing?: (selection: DrawingSelection, drawing: Drawing) => void;
  tool?: string | null;
  magnet?: boolean;
  hidden?: boolean;
  isReplay?: boolean;
  replayIndex?: number;
  isReplaySync?: boolean;
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

function isPointDrawing(drawing: Drawing): drawing is Trendline | Rectangle {
  return "start" in drawing && "end" in drawing;
}

function isTextDrawing(drawing: Drawing): drawing is TextDrawing {
  return "time" in drawing && "price" in drawing && "text" in drawing;
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

export default function Chart({
  data,
  activeChart,
  setActiveChart,
  chartId,
  seriesKey,
  drawings,
  onAddTrendline,
  onAddRectangle,
  onAddText,
  onDeleteDrawing,
  onUpdateDrawing,
  tool,
  magnet = false,
  hidden = false,
  isReplay = false,
  replayIndex = 0,
  isReplaySync = false,
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
  const toolRef = useRef(tool);
  const magnetRef = useRef(magnet);
  const hiddenRef = useRef(hidden);
  const dataRef = useRef(data);
  const drawingsRef = useRef(drawings);
  const selectedDrawingRef = useRef<DrawingSelection | null>(null);
  const onAddTrendlineRef = useRef(onAddTrendline);
  const onAddRectangleRef = useRef(onAddRectangle);
  const onAddTextRef = useRef(onAddText);
  const onDeleteDrawingRef = useRef(onDeleteDrawing);
  const onUpdateDrawingRef = useRef(onUpdateDrawing);

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
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    activeChartRef.current = activeChart ?? null;
  }, [activeChart]);

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
      const x = chart.timeScale().timeToCoordinate(point.time);
      const y = series.priceToCoordinate(point.price);
      if (x === null || y === null) return null;
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

  const pointFromCoordinates = useCallback((x: number, y: number): Point | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !chartReadyRef.current) return null;

    try {
      const time = chart.timeScale().coordinateToTime(x);
      const price = series.coordinateToPrice(y);

      if (typeof time !== "number" || price === null) return null;

      return { time: time as UTCTimestamp, price };
    } catch {
      return null;
    }
  }, []);

  const getRawPointFromParam = useCallback((param: MouseEventParams<Time>): Point | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !chartReadyRef.current || !param.point) return null;

    try {
      const timeFromEvent = param.time;
      const timeFromCoord = chart.timeScale().coordinateToTime(param.point.x);
      const price = series.coordinateToPrice(param.point.y);

      const time =
        typeof timeFromEvent === "number"
          ? timeFromEvent
          : typeof timeFromCoord === "number"
            ? timeFromCoord
            : null;

      if (time === null || price === null) return null;

      return { time: time as UTCTimestamp, price };
    } catch {
      return null;
    }
  }, []);

  const getNearestCandle = useCallback((param: MouseEventParams<Time>): Candle | null => {
    if (typeof param.logical !== "number") return null;

    const index = Math.round(param.logical);
    const candles = dataRef.current;
    if (index < 0 || index >= candles.length) return null;

    return candles[index] ?? null;
  }, []);

  const applyMagnet = useCallback(
    (param: MouseEventParams<Time>, rawPoint: Point): Point => {
      if (!magnetRef.current) {
        return rawPoint;
      }

      const candle = getNearestCandle(param);
      if (!candle) return rawPoint;

      const levels = [candle.open, candle.high, candle.low, candle.close];
      let closest = levels[0];

      for (const level of levels) {
        if (Math.abs(level - rawPoint.price) < Math.abs(closest - rawPoint.price)) {
          closest = level;
        }
      }

      return {
        time: candle.time as UTCTimestamp,
        price: closest,
      };
    },
    [getNearestCandle]
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

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || !chartReadyRef.current) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (hiddenRef.current) {
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
  }, [pointToScreen]);

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

  useEffect(() => {
    clearDrawing();
    setDrawingStep("none");
  }, [tool, clearDrawing]);

  useEffect(() => {
    if (!hidden) {
      setContainerCursor(getDefaultCursor());
      scheduleOverlayDraw();
      return;
    }

    resetDragState();
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    selectedDrawingRef.current = null;
    setDrawingStep("none");
    setSelectedDrawing(null);
    scheduleOverlayDraw();
  }, [getDefaultCursor, hidden, resetDragState, scheduleOverlayDraw, setContainerCursor]);

  useEffect(() => {
    hasInitialData.current = false;
    resetDragState();
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    setDrawingStep("none");
    setSelectedDrawing(null);
    scheduleOverlayDraw();
  }, [resetDragState, scheduleOverlayDraw, seriesKey]);

  useEffect(() => {
    if (activeChart && activeChart !== chartId && selectedDrawingRef.current) {
      resetDragState();
      setSelectedDrawing(null);
    }
  }, [activeChart, chartId, resetDragState]);

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
  }, [getDefaultCursor, setContainerCursor, tool]);

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

      if (dragMovedRef.current) {
        suppressClickRef.current = true;
      }

      resetDragState();
    };

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [resetDragState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete") return;
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

      if (drawStartRef.current) {
        drawStartRef.current = null;
        drawPreviewRef.current = null;
        setDrawingStep("none");
        scheduleOverlayDraw();
        event.preventDefault();
        return;
      }

      const currentSelection = selectedDrawingRef.current;
      if (!currentSelection) return;

      onDeleteDrawingRef.current?.(currentSelection.id);
      setSelectedDrawing(null);
      event.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chartId, scheduleOverlayDraw]);

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
              onUpdateDrawingRef.current?.(selection, {
                ...initial,
                time: (initial.time + dx) as UTCTimestamp,
                price: initial.price + dy,
              });
            } else if (isPointDrawing(initial)) {
              onUpdateDrawingRef.current?.(selection, {
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
            onUpdateDrawingRef.current?.(selection, {
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
            onUpdateDrawingRef.current?.(
              selection,
              {
                ...initial,
                ...getRectangleEdgeResizePoints(initial, dragModeRef.current, snappedPoint),
              }
            );
          } else if (snappedPoint && isPointDrawing(initial)) {
            onUpdateDrawingRef.current?.(selection, {
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

        if (hiddenRef.current) {
          scheduleOverlayDraw();
          return;
        }

        if (!param.point) return;

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
            id: createDrawingId("text"),
            time: point.time,
            price: point.price,
            text: enteredText.trim() || "Text",
            color: theme.accent,
            width: 1,
            opacity: 1,
          };
          onAddTextRef.current(chartId, text);
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
            id: createDrawingId("trendline"),
            start,
            end: point,
            extend: DEFAULT_TRENDLINE_EXTENSION,
            color: theme.accent,
            width: 2,
            opacity: 1,
          };
          onAddTrendlineRef.current(chartId, line);
          setSelectedDrawing({ type: "trendline", id: line.id });
        } else {
          const rect: Rectangle = {
            id: createDrawingId("rectangle"),
            start,
            end: point,
            color: "#f5a623",
            width: 2,
            opacity: 1,
          };
          onAddRectangleRef.current(chartId, rect);
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
    // When sync is OFF and this chart is not active, keep it stable (don't flicker with live updates)
    if (isReplay && !isReplaySync && activeChart !== chartId) {
      return;
    }

    try {
      // Priority: use live data if available, otherwise fallback to historical from store
      // seriesKey format: "nq" (symbol part before the timeframe)
      const symbol = seriesKey;
      const candlesFromStore = candleStoreData[symbol] ? Object.values(candleStoreData[symbol]).flat() : [];
      let displayData: Candle[] = data.length > 0 
        ? data 
        : candlesFromStore;

      // Apply replay slicing if in replay mode
      // Safety: bound replayIndex to actual data length to prevent blank charts on symbol/timeframe switches
      // If sync is OFF, only apply replay to the active chart; otherwise all charts show replay data
      const shouldApplyReplay = isReplay && replayIndex > 0 && (isReplaySync || activeChart === chartId);
      
      if (shouldApplyReplay) {
        const safeIndex = Math.min(replayIndex, displayData.length);
        displayData = displayData.slice(0, safeIndex);
      }

      const nextData = displayData.map((candle) => ({
        ...candle,
        time: candle.time as UTCTimestamp,
      })) as CandlestickData<Time>[];
      seriesRef.current.setData(nextData);

      if (!hasInitialData.current && nextData.length > 0) {
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
  }, [data, candleStoreData, seriesKey, isReplay, replayIndex, isReplaySync, activeChart, chartId, scheduleOverlayDraw]);

  useEffect(() => {
    scheduleOverlayDraw();
  }, [drawings, scheduleOverlayDraw]);

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

      {hidden && (
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

      {!hidden && (tool === "trendline" || tool === "rectangle") && (
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

      {!hidden && tool === "text" && (
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
