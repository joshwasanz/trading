import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Point = {
  time: number;
  price: number;
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
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);

  const rangeTimeoutRef = useRef<any>(null);
  const hasInitialData = useRef(false);

  const activeChartRef = useRef<string | null>(null);

  // 🔥 DRAWING STATE
  const drawingRef = useRef<{
    start: Point | null;
    tempSeries: any;
  }>({
    start: null,
    tempSeries: null,
  });

  // 🔥 UI STATE FOR DRAWING FEEDBACK
  const [drawingStep, setDrawingStep] = useState<"none" | "started" | "finished">("none");

  useEffect(() => {
    activeChartRef.current = activeChart ?? null;
  }, [activeChart]);

  // 🔥 RESET DRAWING STATE WHEN TOOL CHANGES
  useEffect(() => {
    if (tool !== "trendline") {
      setDrawingStep("none");
      drawingRef.current.start = null;
      drawingRef.current.tempSeries = null;
    }
  }, [tool]);

  // ==================== CREATE CHART ====================
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    const chart = createChart(container, {
      width: 0,
      height: 0,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
      },
      layout: {
        background: { color: "#0e0e11" },
        textColor: "#c9ced6",
      },
      grid: {
        vertLines: { color: "#1c1f26" },
        horzLines: { color: "#1c1f26" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // ==================== ACTIVE ====================
    const handleMouseDown = () => {
      setActiveChart?.(chartId);
    };

    container.addEventListener("mousedown", handleMouseDown);

    // ==================== RESIZE ====================
    requestAnimationFrame(() => {
      chart.resize(container.clientWidth, container.clientHeight);
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.resize(container.clientWidth, container.clientHeight);
    });

    resizeObserver.observe(container);

    // ==================== RANGE ====================
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      if (activeChartRef.current !== chartId) return;

      clearTimeout(rangeTimeoutRef.current);

      rangeTimeoutRef.current = setTimeout(() => {
        onTimeRangeChange?.(range, chartId);
      }, 60);
    });

    // ==================== CROSSHAIR ====================
    let lastCrosshairTime = 0;
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return;

      lastCrosshairTime = param.time as number;
      onCrosshairMove?.(param.time as number);

      // 🔥 DRAW PREVIEW
      if (tool === "trendline" && drawingRef.current.start) {
        drawingRef.current.tempSeries.setData([
          { time: drawingRef.current.start.time, value: drawingRef.current.start.price },
          { time: lastCrosshairTime, value: drawingRef.current.start.price },
        ]);
      }
    });

    // ==================== CLICK DRAW ====================
    const handleClick = (_e: MouseEvent) => {
      if (tool !== "trendline") {
        console.log("ℹ️ Tool is not trendline, skipping:", tool);
        return;
      }

      console.log("🎯 Trendline click detected!", { tool, dataLength: data.length });

      // 🔥 Get nearest time value from chart state
      const lastCandle = data[data.length - 1];
      if (!lastCandle) {
        console.warn("⚠️ No candle data available");
        return;
      }

      const price = (lastCandle.high + lastCandle.low) / 2;
      // Use last candle time as approximate time for drawing
      const time = lastCandle.time as any;

      const point: Point = {
        time: lastCandle.time,
        price,
      };

      // FIRST CLICK
      if (!drawingRef.current.start) {
        console.log("✓ First click - starting trendline");
        drawingRef.current.start = point;
        setDrawingStep("started"); // 🔥 UPDATE UI STATE

        const tempSeries = chart.addLineSeries({
          color: "#4da3ff",
          lineWidth: 2,
        });

        drawingRef.current.tempSeries = tempSeries;
        tempSeries.setData([
          { time, value: price },
          { time, value: price },
        ]);
        return;
      }

      // SECOND CLICK → finalize
      console.log("✓ Second click - finalizing trendline");
      drawingRef.current.tempSeries.setData([
        { time: drawingRef.current.start.time as any, value: drawingRef.current.start.price },
        { time, value: point.price },
      ]);

      drawingRef.current.start = null;
      drawingRef.current.tempSeries = null;
      setDrawingStep("finished"); // 🔥 UPDATE UI STATE
      setTimeout(() => setDrawingStep("none"), 1000); // Reset after 1 second
    };

    // 🔥 ADD CLICK LISTENER
    console.log("📌 Attaching click listener, current tool:", tool);
    container.addEventListener("click", handleClick);

    return () => {
      console.log("🗑️ Cleaning up event listeners");
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("click", handleClick);
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [chartId, tool]);

  // ==================== DATA ====================
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    if (!data || data.length === 0) return;

    seriesRef.current.setData(data);

    if (!hasInitialData.current) {
      hasInitialData.current = true;
      chartRef.current.timeScale().fitContent();
    }
  }, [data]);

  // ==================== SYNC ====================
  useEffect(() => {
    if (!chartRef.current || !externalRange) return;
    if (rangeSource === chartId) return;

    chartRef.current.timeScale().setVisibleLogicalRange(externalRange);
  }, [externalRange, rangeSource]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="chart-canvas" />
      
      {/* 🔥 DRAWING STATUS INDICATOR */}
      {tool === "trendline" && (
        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            padding: "4px 12px",
            background:
              drawingStep === "started"
                ? "#4da3ff"
                : drawingStep === "finished"
                  ? "#26a69a"
                  : "rgba(77, 163, 255, 0.3)",
            color: "#fff",
            fontSize: "11px",
            borderRadius: "3px",
            fontWeight: "500",
            zIndex: 10,
            animation:
              drawingStep === "started"
                ? "pulse 0.5s ease-out"
                : drawingStep === "finished"
                  ? "pop 0.5s ease-out"
                  : "none",
          }}
        >
          {drawingStep === "none" && "Click to draw trendline"}
          {drawingStep === "started" && "✓ Click again to finish"}
          {drawingStep === "finished" && "✓ Done!"}
        </div>
      )}
    </div>
  );
}