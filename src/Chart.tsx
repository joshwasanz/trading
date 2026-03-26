import { useEffect, useRef } from "react";
import { createChart } from "lightweight-charts";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Props = {
  data: Candle[];
  symbol: string;
  onCrosshairMove?: (time: number) => void;
  externalTime?: number | null;
  onTimeRangeChange?: (range: any, symbol: string) => void;
  externalRange?: any;
  activeChart?: string | null;
  setActiveChart?: (symbol: string) => void;
};

export default function Chart({
  data,
  symbol,
  onCrosshairMove,
  externalTime,
  onTimeRangeChange,
  externalRange,
  activeChart,
  setActiveChart,
}: Props) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const activeChartRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    activeChartRef.current = activeChart ?? null;
  }, [activeChart]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    isMountedRef.current = true;
    const container = chartContainerRef.current;
    console.log(`[${symbol}] Creating chart...`);
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
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
      },
      layout: {
        background: { color: "#0e0e11" },
        textColor: "#ccc",
      },
      grid: {
        vertLines: { color: "#1e1e22" },
        horzLines: { color: "#1e1e22" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
      },
    });

    const series = chart.addCandlestickSeries();
    series.priceScale().applyOptions({
      autoScale: false,
      scaleMargins: {
        top: 0.1,
        bottom: 0.2,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    resizeObserverRef.current = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      chart.resize(width, height);
    });
    resizeObserverRef.current.observe(container);

    const handleMouseDown = () => {
      console.log(`[${symbol}] Chart focused`);
      setActiveChart?.(symbol);
    };

    container.addEventListener("mousedown", handleMouseDown);

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return;
      onCrosshairMove?.(param.time as number);
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      if (activeChartRef.current !== symbol) return;
      onTimeRangeChange?.(range, symbol);
    });

    console.log(`[${symbol}] Chart initialized and listeners subscribed ✓`);

    return () => {
      console.log(`[${symbol}] Cleaning up chart...`);
      isMountedRef.current = false;
      container.removeEventListener("mousedown", handleMouseDown);
      resizeObserverRef.current?.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!isMountedRef.current || !chartRef.current || !externalTime || !seriesRef.current) return;
    
    try {
      chartRef.current.setCrosshairPosition(
        0,
        externalTime as any,
        seriesRef.current
      );
    } catch (error) {
      // Chart might be in process of being destroyed, ignore silently
      console.debug("Could not set crosshair position:", error);
    }
  }, [externalTime]);

  useEffect(() => {
    if (!isMountedRef.current || !chartRef.current || !externalRange) return;
    if (activeChart === symbol) return;
    
    try {
      chartRef.current.timeScale().setVisibleLogicalRange(externalRange);
    } catch (error) {
      console.debug("Could not set visible logical range:", error);
    }
  }, [externalRange, activeChart, symbol]);

  useEffect(() => {
    if (!isMountedRef.current || !seriesRef.current || data.length === 0) {
      console.debug(`[${symbol}] Skipping data update - mounted:${isMountedRef.current}, hasData:${data.length > 0}`);
      return;
    }

    console.log(`[${symbol}] Updating chart with ${data.length} candles`);
    try {
      seriesRef.current.setData(
        data.map((candle) => ({
          time: candle.time as any,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        }))
      );

      if (data.length <= 1 && chartRef.current) {
        chartRef.current.timeScale().fitContent();
      }
    } catch (error) {
      console.debug("Could not update chart data:", error);
    }
  }, [data]);

  return (
    <div
      ref={chartContainerRef}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
