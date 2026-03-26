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

  useEffect(() => {
    activeChartRef.current = activeChart ?? null;
  }, [activeChart]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const container = chartContainerRef.current;
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

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      resizeObserverRef.current?.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !externalTime) return;
    chartRef.current.setCrosshairPosition(
      0,
      externalTime as any,
      seriesRef.current
    );
  }, [externalTime]);

  useEffect(() => {
    if (!chartRef.current || !externalRange) return;
    if (activeChart === symbol) return;
    chartRef.current.timeScale().setVisibleLogicalRange(externalRange);
  }, [externalRange, activeChart, symbol]);

  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;

    if (data.length === 1) {
      seriesRef.current.setData([
        {
          time: data[0].time as any,
          open: data[0].open,
          high: data[0].high,
          low: data[0].low,
          close: data[0].close,
        },
      ]);
    } else {
      const last = data[data.length - 1];
      seriesRef.current.update({
        time: last.time as any,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      });
    }

    if (data.length <= 1) {
      chartRef.current.timeScale().fitContent();
    }
  }, [data]);

  return (
    <div
      ref={chartContainerRef}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
