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
import type { ChartDrawings, Point, Rectangle, Trendline } from "./types/drawings";

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
  tool?: string | null;
};

type ScreenPoint = {
  x: number;
  y: number;
};

function getExtendedLine(
  start: ScreenPoint,
  end: ScreenPoint,
  width: number,
  height: number
): { start: ScreenPoint; end: ScreenPoint } | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) return null;

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

  if (intersections.length < 2) return null;

  intersections.sort((a, b) => a.t - b.t);
  return {
    start: intersections[0].point,
    end: intersections[intersections.length - 1].point,
  };
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
  tool,
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
  const drawingsRef = useRef(drawings);
  const onCrosshairMoveRef = useRef(onCrosshairMove);
  const onTimeRangeChangeRef = useRef(onTimeRangeChange);

  const drawStartRef = useRef<Point | null>(null);
  const drawPreviewRef = useRef<Point | null>(null);

  const setTool = useToolStore((state) => state.setTool);
  const [drawingStep, setDrawingStep] = useState<"none" | "started">("none");

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    activeChartRef.current = activeChart ?? null;
  }, [activeChart]);

  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);

  useEffect(() => {
    onCrosshairMoveRef.current = onCrosshairMove;
  }, [onCrosshairMove]);

  useEffect(() => {
    onTimeRangeChangeRef.current = onTimeRangeChange;
  }, [onTimeRangeChange]);

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const toXY = (point: Point): ScreenPoint | null => {
      try {
        const x = chart.timeScale().timeToCoordinate(point.time);
        const y = series.priceToCoordinate(point.price);
        if (x === null || y === null) return null;
        return { x: x * dpr, y: y * dpr };
      } catch {
        return null;
      }
    };

    ctx.save();
    ctx.strokeStyle = "#4da3ff";
    ctx.lineWidth = 2 * dpr;
    ctx.lineCap = "round";

    for (const line of drawingsRef.current.trendlines) {
      const start = toXY(line.start);
      const end = toXY(line.end);
      if (!start || !end) continue;

      const extended = getExtendedLine(start, end, canvas.width, canvas.height);
      if (!extended) continue;

      ctx.beginPath();
      ctx.moveTo(extended.start.x, extended.start.y);
      ctx.lineTo(extended.end.x, extended.end.y);
      ctx.stroke();
    }

    if (toolRef.current === "trendline" && drawStartRef.current && drawPreviewRef.current) {
      const start = toXY(drawStartRef.current);
      const end = toXY(drawPreviewRef.current);
      if (start && end) {
        const extended = getExtendedLine(start, end, canvas.width, canvas.height);
        if (extended) {
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
    ctx.strokeStyle = "#f5a623";
    ctx.fillStyle = "rgba(245, 166, 35, 0.15)";
    ctx.lineWidth = 2 * dpr;

    for (const rect of drawingsRef.current.rectangles) {
      const start = toXY(rect.start);
      const end = toXY(rect.end);
      if (!start || !end) continue;

      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);

      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.fill();
      ctx.stroke();
    }

    if (toolRef.current === "rectangle" && drawStartRef.current && drawPreviewRef.current) {
      const start = toXY(drawStartRef.current);
      const end = toXY(drawPreviewRef.current);
      if (start && end) {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);

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
  }, []);

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
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    setDrawingStep("none");
  }, [seriesKey]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    hasInitialData.current = false;
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

    const handleMouseDown = () => setActiveChart?.(chartId);
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

    const getPoint = (param: MouseEventParams<Time>): Point | null => {
      if (!param.point) return null;

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
    };

    const handleVisibleRangeChange = (range: any) => {
      scheduleOverlayDraw();
      if (!range || activeChartRef.current !== chartId) return;

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
        const point = getPoint(param);
        if (point) {
          onCrosshairMoveRef.current?.(point.time as number);
        }

        if (
          (toolRef.current === "trendline" || toolRef.current === "rectangle") &&
          drawStartRef.current &&
          point
        ) {
          drawPreviewRef.current = point;
          scheduleOverlayDraw();
        }
      } catch (error) {
        console.error("[Chart] crosshairMove error:", error);
      }
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const handleClick = (param: MouseEventParams<Time>) => {
      try {
        const currentTool = toolRef.current;
        if (currentTool !== "trendline" && currentTool !== "rectangle") return;

        const point = getPoint(param);
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
          onAddTrendline(chartId, { start, end: point });
        } else {
          onAddRectangle(chartId, { start, end: point });
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

      if (chartRef.current === chart) chartRef.current = null;
      if (seriesRef.current === series) seriesRef.current = null;
    };
  }, [chartId, onAddRectangle, onAddTrendline, scheduleOverlayDraw, setActiveChart, setTool, syncOverlaySize]);

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
