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

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Point = {
  time: UTCTimestamp;
  price: number;
};

type Trendline = {
  start: Point;
  end: Point;
};

type Rectangle = {
  start: Point;
  end: Point;
};

type Props = {
  data: Candle[];
  symbol: string;
  onCrosshairMove?: (time: number) => void;
  onTimeRangeChange?: (range: any, chartId: string) => void;
  externalRange?: any;
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  rangeSource?: string | null;
  chartId: string;
  tool?: string | null;
};

export default function Chart({
  data,
  onCrosshairMove,
  onTimeRangeChange,
  externalRange,
  activeChart,
  setActiveChart,
  rangeSource,
  chartId,
  tool,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const rangeTimeoutRef = useRef<number | null>(null);
  const drawingStepTimeoutRef = useRef<number | null>(null);
  const hasInitialData = useRef(false);
  const activeChartRef = useRef<string | null>(null);
  const toolRef = useRef(tool);

  // Drawing data — stored in refs so no React re-render needed for canvas ops
  const drawStartRef = useRef<Point | null>(null);
  const drawPreviewRef = useRef<Point | null>(null);
  const trendlinesRef = useRef<Trendline[]>([]);
  const rectanglesRef = useRef<Rectangle[]>([]);

  const [drawingStep, setDrawingStep] = useState<"none" | "started" | "finished">("none");

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { activeChartRef.current = activeChart ?? null; }, [activeChart]);

  // ── CANVAS OVERLAY ────────────────────────────────────────────────────────

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const toXY = (p: Point): { x: number; y: number } | null => {
      try {
        const x = chart.timeScale().timeToCoordinate(p.time);
        const y = series.priceToCoordinate(p.price);
        if (x === null || y === null) return null;
        return { x: x * dpr, y: y * dpr };
      } catch {
        return null;
      }
    };

    // Committed trendlines
    ctx.save();
    ctx.strokeStyle = "#4da3ff";
    ctx.lineWidth = 2 * dpr;
    ctx.lineCap = "round";
    for (const line of trendlinesRef.current) {
      const s = toXY(line.start);
      const e = toXY(line.end);
      if (!s || !e) continue;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    }

    // Live preview trendline
    if (toolRef.current === "trendline" && drawStartRef.current && drawPreviewRef.current) {
      const s = toXY(drawStartRef.current);
      const e = toXY(drawPreviewRef.current);
      if (s && e) {
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    // Committed rectangles
    ctx.save();
    ctx.strokeStyle = "#f5a623";
    ctx.fillStyle = "rgba(245, 166, 35, 0.15)";
    ctx.lineWidth = 2 * dpr;
    for (const rect of rectanglesRef.current) {
      const s = toXY(rect.start);
      const e = toXY(rect.end);
      if (!s || !e) continue;
      const x = Math.min(s.x, e.x);
      const y = Math.min(s.y, e.y);
      const w = Math.abs(e.x - s.x);
      const h = Math.abs(e.y - s.y);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.stroke();
    }

    // Live preview rectangle
    if (toolRef.current === "rectangle" && drawStartRef.current && drawPreviewRef.current) {
      const s = toXY(drawStartRef.current);
      const e = toXY(drawPreviewRef.current);
      if (s && e) {
        const x = Math.min(s.x, e.x);
        const y = Math.min(s.y, e.y);
        const w = Math.abs(e.x - s.x);
        const h = Math.abs(e.y - s.y);
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }, []);

  const syncOverlaySize = useCallback(() => {
    const canvas = overlayRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    drawOverlay();
  }, [drawOverlay]);

  // ── DRAWING STATE ─────────────────────────────────────────────────────────

  const clearDrawing = useCallback(() => {
    if (drawingStepTimeoutRef.current !== null) {
      window.clearTimeout(drawingStepTimeoutRef.current);
      drawingStepTimeoutRef.current = null;
    }
    drawStartRef.current = null;
    drawPreviewRef.current = null;
    drawOverlay();
  }, [drawOverlay]);

  // Always reset in-progress drawing when the active tool changes.
  // Critical: switching between drawing tools (trendline ↔ rectangle) must
  // also clear drawStartRef, otherwise the next click is wrongly treated as
  // the SECOND click of a new shape.
  useEffect(() => {
    clearDrawing();
    setDrawingStep("none");
  }, [tool, clearDrawing]);

  // ── CHART SETUP ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    hasInitialData.current = false;
    trendlinesRef.current = [];
    rectanglesRef.current = [];
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

    requestAnimationFrame(() => {
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

      // Prefer the snapped candle time; fall back to interpolated coordinate time.
      // Both are checked explicitly — coordinateToTime can return BusinessDay or null.
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
      drawOverlay(); // redraw lines when chart pans/zooms
      if (!range || activeChartRef.current !== chartId) return;
      if (rangeTimeoutRef.current !== null) window.clearTimeout(rangeTimeoutRef.current);
      rangeTimeoutRef.current = window.setTimeout(() => {
        onTimeRangeChange?.(range, chartId);
      }, 60);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      try {
        const point = getPoint(param);
        if (point) onCrosshairMove?.(point.time as number);

        if (
          (toolRef.current === "trendline" || toolRef.current === "rectangle") &&
          drawStartRef.current &&
          point
        ) {
          drawPreviewRef.current = point;
          drawOverlay();
        }
      } catch (err) {
        console.error("[Chart] crosshairMove error:", err);
      }
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const handleClick = (param: MouseEventParams<Time>) => {
      try {
        const currentTool = toolRef.current;
        if (currentTool !== "trendline" && currentTool !== "rectangle") return;

        const point = getPoint(param);
        if (!point) return;

        if (drawingStepTimeoutRef.current !== null) {
          window.clearTimeout(drawingStepTimeoutRef.current);
          drawingStepTimeoutRef.current = null;
        }

        // ── FIRST CLICK: set start ──
        if (!drawStartRef.current) {
          drawStartRef.current = point;
          drawPreviewRef.current = point;
          setDrawingStep("started");
          drawOverlay();
          return;
        }

        // ── SECOND CLICK: commit ──
        if (currentTool === "trendline") {
          if (point.time === drawStartRef.current.time) return; // same candle — ignore
          trendlinesRef.current = [
            ...trendlinesRef.current,
            { start: drawStartRef.current, end: point },
          ];
        } else if (currentTool === "rectangle") {
          rectanglesRef.current = [
            ...rectanglesRef.current,
            { start: drawStartRef.current, end: point },
          ];
        }

        drawStartRef.current = null;
        drawPreviewRef.current = null;
        drawOverlay();

        setDrawingStep("finished");
        drawingStepTimeoutRef.current = window.setTimeout(() => {
          setDrawingStep("none");
          drawingStepTimeoutRef.current = null;
        }, 1000);
      } catch (err) {
        console.error("[Chart] click error:", err);
        drawStartRef.current = null;
        drawPreviewRef.current = null;
        drawOverlay();
        setDrawingStep("none");
      }
    };
    chart.subscribeClick(handleClick);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      if (rangeTimeoutRef.current !== null) window.clearTimeout(rangeTimeoutRef.current);
      if (drawingStepTimeoutRef.current !== null) window.clearTimeout(drawingStepTimeoutRef.current);
      resizeObserver.disconnect();
      chart.remove();
      if (chartRef.current === chart) chartRef.current = null;
      if (seriesRef.current === series) seriesRef.current = null;
    };
  }, [chartId, drawOverlay, syncOverlaySize]);

  // ── DATA ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current || !data?.length) return;
    try {
      seriesRef.current.setData(
        data.map((c) => ({ ...c, time: c.time as UTCTimestamp })) as CandlestickData<Time>[]
      );
      if (!hasInitialData.current) {
        hasInitialData.current = true;
        chartRef.current.timeScale().fitContent();
      }
    } catch (err) {
      console.error("[Chart] setData error:", err);
    }
  }, [data]);

  useEffect(() => {
    if (!chartRef.current || !externalRange || rangeSource === chartId) return;
    try {
      chartRef.current.timeScale().setVisibleLogicalRange(externalRange);
    } catch (err) {
      console.error("[Chart] setVisibleLogicalRange error:", err);
    }
  }, [externalRange, rangeSource, chartId]);

  // ── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="chart-canvas" />

      {/* Trendline canvas overlay — pointer-events:none so chart receives all mouse events */}
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
                ? tool === "rectangle" ? "#f5a623" : "#4da3ff"
                : drawingStep === "finished"
                ? "#26a69a"
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
          {drawingStep === "finished" && (tool === "rectangle" ? "✓ Rectangle drawn" : "✓ Trendline drawn")}
        </div>
      )}
    </div>
  );
}
