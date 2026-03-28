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
import {
  DEFAULT_TRENDLINE_EXTENSION,
  createDrawingId,
  type ChartDrawings,
  type DrawingSelection,
  type LineExtension,
  type Point,
  type Rectangle,
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
  onCrosshairMove?: (time: number) => void;
  onTimeRangeChange?: (range: any, chartId: string) => void;
  externalRange?: any;
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  rangeSource?: string | null;
  chartId: string;
  seriesKey: string;
  drawings: ChartDrawings;
  onAddTrendline: (chartId: string, line: Trendline) => void;
  onAddRectangle: (chartId: string, rect: Rectangle) => void;
  onDeleteDrawing?: (id: string) => void;
  onUpdateDrawing?: (selection: DrawingSelection, points: { start: Point; end: Point }) => void;
  tool?: string | null;
  magnet?: boolean;
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

export default function Chart({
  data,
  onCrosshairMove,
  onTimeRangeChange,
  externalRange,
  activeChart,
  setActiveChart,
  rangeSource,
  chartId,
  seriesKey,
  drawings,
  onAddTrendline,
  onAddRectangle,
  onDeleteDrawing,
  onUpdateDrawing,
  tool,
  magnet = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const rangeTimeoutRef = useRef<number | null>(null);
  const overlayFrameRef = useRef<number | null>(null);
  const hasInitialData = useRef(false);
  const activeChartRef = useRef<string | null>(null);
  const toolRef = useRef(tool);
  const magnetRef = useRef(magnet);
  const dataRef = useRef(data);
  const drawingsRef = useRef(drawings);
  const selectedDrawingRef = useRef<DrawingSelection | null>(null);
  const onCrosshairMoveRef = useRef(onCrosshairMove);
  const onTimeRangeChangeRef = useRef(onTimeRangeChange);
  const onDeleteDrawingRef = useRef(onDeleteDrawing);
  const onUpdateDrawingRef = useRef(onUpdateDrawing);

  const drawStartRef = useRef<Point | null>(null);
  const drawPreviewRef = useRef<Point | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartPointRef = useRef<Point | null>(null);
  const dragStartScreenRef = useRef<ScreenPoint | null>(null);
  const dragInitialRef = useRef<{ start: Point; end: Point } | null>(null);
  const dragModeRef = useRef<DragMode>("move");
  const dragMovedRef = useRef(false);
  const suppressClickRef = useRef(false);

  const setTool = useToolStore((state) => state.setTool);
  const [drawingStep, setDrawingStep] = useState<"none" | "started">("none");
  const [selectedDrawing, setSelectedDrawing] = useState<DrawingSelection | null>(null);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    magnetRef.current = magnet;
  }, [magnet]);

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
    onCrosshairMoveRef.current = onCrosshairMove;
  }, [onCrosshairMove]);

  useEffect(() => {
    onTimeRangeChangeRef.current = onTimeRangeChange;
  }, [onTimeRangeChange]);

  useEffect(() => {
    onDeleteDrawingRef.current = onDeleteDrawing;
  }, [onDeleteDrawing]);

  useEffect(() => {
    onUpdateDrawingRef.current = onUpdateDrawing;
  }, [onUpdateDrawing]);

  const pointToScreen = useCallback((point: Point): ScreenPoint | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;

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
      const canvas = overlayRef.current;
      if (!canvas) return null;

      const threshold = 6 * (window.devicePixelRatio || 1);

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

    return selection.type === "trendline"
      ? drawingsRef.current.trendlines.find((line) => line.id === selection.id) ?? null
      : drawingsRef.current.rectangles.find((rect) => rect.id === selection.id) ?? null;
  }, []);

  const hitTestSelectedHandles = useCallback(
    (screenPoint: ScreenPoint): DragTarget | null => {
      const selection = selectedDrawingRef.current;
      const drawing = getDrawingBySelection(selection);
      if (!selection || !drawing) return null;

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
    (initial: { start: Point; end: Point }, dragMode: DragMode, point: Point) => {
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
    if (!chart || !series) return null;

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
    if (!chart || !series || !param.point) return null;

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
    return toolRef.current === "trendline" || toolRef.current === "rectangle"
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
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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

      ctx.strokeStyle = isSelected ? "#ffffff" : "#4da3ff";
      ctx.lineWidth = (isSelected ? 3 : 2) * dpr;
      ctx.beginPath();
      ctx.moveTo(extended.start.x, extended.start.y);
      ctx.lineTo(extended.end.x, extended.end.y);
      ctx.stroke();

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
          ctx.strokeStyle = "#4da3ff";
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
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);

      ctx.strokeStyle = isSelected ? "#ffffff" : "#f5a623";
      ctx.fillStyle = isSelected ? "rgba(255, 255, 255, 0.12)" : "rgba(245, 166, 35, 0.15)";
      ctx.lineWidth = (isSelected ? 3 : 2) * dpr;
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.fill();
      ctx.stroke();

      if (isSelected) {
        ctx.fillStyle = "#ffffff";
        drawSelectionHandle(ctx, start, 4 * dpr);
        drawSelectionHandle(ctx, end, 4 * dpr);
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

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    scheduleOverlayDraw();
  }, [scheduleOverlayDraw]);

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
    hasInitialData.current = false;
    resetDragState();
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    setDrawingStep("none");
  }, [seriesKey, resetDragState]);

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
        : drawings.rectangles.some((rect) => rect.id === selectedDrawing.id);

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
    resetDragState();
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    setDrawingStep("none");

    const chart = createChart(container, {
      width: 0,
      height: 0,
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
      },
      layout: {
        background: { color: "#0e0e11" },
        textColor: "#c9ced6",
      },
      grid: {
        vertLines: { color: "#1c1f26" },
        horzLines: { color: "#1c1f26" },
      },
      crosshair: { mode: CrosshairMode.Normal },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleMouseDown = (event: MouseEvent) => {
      setActiveChart?.(chartId);
      activeChartRef.current = chartId;

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
      dragInitialRef.current = {
        start: { ...drawing.start },
        end: { ...drawing.end },
      };
      dragModeRef.current = dragTarget.dragMode;
      dragMovedRef.current = false;
      setPressedNavigationEnabled(false);
      setContainerCursor(
        dragTarget.dragMode === "move" ? "grabbing" : getDragModeCursor(dragTarget.dragMode)
      );
      event.preventDefault();
    };
    container.addEventListener("mousedown", handleMouseDown);

    window.requestAnimationFrame(() => {
      chart.resize(container.clientWidth, container.clientHeight);
      syncOverlaySize();
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.resize(container.clientWidth, container.clientHeight);
      syncOverlaySize();
    });
    resizeObserver.observe(container);

    const handleVisibleRangeChange = (range: any) => {
      scheduleOverlayDraw();
      if (!range || activeChartRef.current !== chartId) {
        return;
      }

      if (rangeTimeoutRef.current !== null) {
        window.clearTimeout(rangeTimeoutRef.current);
      }

      rangeTimeoutRef.current = window.setTimeout(() => {
        onTimeRangeChangeRef.current?.(range, chartId);
      }, 60);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      try {
        const rawPoint = getRawPointFromParam(param);
        const snappedPoint = getSnappedPointFromParam(param);
        if (rawPoint) {
          onCrosshairMoveRef.current?.(rawPoint.time as number);
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

          if (dragModeRef.current === "move") {
            const dx = rawPoint.time - dragStartPointRef.current.time;
            const dy = rawPoint.price - dragStartPointRef.current.price;
            onUpdateDrawingRef.current?.(selection, {
              start: {
                time: (initial.start.time + dx) as UTCTimestamp,
                price: initial.start.price + dy,
              },
              end: {
                time: (initial.end.time + dx) as UTCTimestamp,
                price: initial.end.price + dy,
              },
            });
          } else if (dragModeRef.current === "resize-start" && snappedPoint) {
            onUpdateDrawingRef.current?.(selection, {
              start: snappedPoint,
              end: initial.end,
            });
          } else if (
            selection.type === "rectangle" &&
            (dragModeRef.current === "resize-left" ||
              dragModeRef.current === "resize-right" ||
              dragModeRef.current === "resize-top" ||
              dragModeRef.current === "resize-bottom") &&
            snappedPoint
          ) {
            onUpdateDrawingRef.current?.(
              selection,
              getRectangleEdgeResizePoints(initial, dragModeRef.current, snappedPoint)
            );
          } else if (snappedPoint) {
            onUpdateDrawingRef.current?.(selection, {
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

        if (
          (toolRef.current === "trendline" || toolRef.current === "rectangle") &&
          drawStartRef.current &&
          snappedPoint
        ) {
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
          };
          onAddTrendline(chartId, line);
          setSelectedDrawing({ type: "trendline", id: line.id });
        } else {
          const rect: Rectangle = {
            id: createDrawingId("rectangle"),
            start,
            end: point,
          };
          onAddRectangle(chartId, rect);
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
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

      if (rangeTimeoutRef.current !== null) {
        window.clearTimeout(rangeTimeoutRef.current);
      }

      if (overlayFrameRef.current !== null) {
        window.cancelAnimationFrame(overlayFrameRef.current);
      }

      resizeObserver.disconnect();
      chart.remove();
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
    onAddRectangle,
    onAddTrendline,
    pointFromCoordinates,
    resetDragState,
    scheduleOverlayDraw,
    setActiveChart,
    setContainerCursor,
    setPressedNavigationEnabled,
    setTool,
    syncOverlaySize,
  ]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    try {
      const nextData = data.map((candle) => ({
        ...candle,
        time: candle.time as UTCTimestamp,
      })) as CandlestickData<Time>[];
      seriesRef.current.setData(nextData);

      if (!hasInitialData.current && nextData.length > 0) {
        hasInitialData.current = true;
        chartRef.current.timeScale().fitContent();
      }

      scheduleOverlayDraw();
    } catch (error) {
      console.error("[Chart] setData error:", error);
    }
  }, [data, scheduleOverlayDraw]);

  useEffect(() => {
    if (!chartRef.current || !externalRange || rangeSource === chartId) return;

    try {
      chartRef.current.timeScale().setVisibleLogicalRange(externalRange);
    } catch (error) {
      console.error("[Chart] setVisibleLogicalRange error:", error);
    }
  }, [externalRange, rangeSource, chartId]);

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

      {(tool === "trendline" || tool === "rectangle") && (
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
                  : "#4da3ff"
                : tool === "rectangle"
                  ? "rgba(245, 166, 35, 0.3)"
                  : "rgba(77, 163, 255, 0.3)",
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
    </div>
  );
}
