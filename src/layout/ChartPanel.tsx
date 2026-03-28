import Chart from "../Chart";
import type { ChartDrawings, DrawingSelection, Point, Rectangle, Trendline } from "../types/drawings";

type Timeframe = "15s" | "1m" | "3m";

type Props = {
  panelId: string;
  symbol: string;
  timeframe: Timeframe;
  data: any[];
  drawings: ChartDrawings;
  onAddTrendline: (symbol: string, line: Trendline) => void;
  onAddRectangle: (symbol: string, rect: Rectangle) => void;
  onDeleteDrawing?: (symbol: string, id: string) => void;
  onUpdateDrawing?: (
    symbol: string,
    selection: DrawingSelection,
    points: { start: Point; end: Point }
  ) => void;
  onFocus: () => void;
  onSymbolChange?: (symbol: string) => void;
  onTimeframeChange?: (tf: Timeframe) => void;
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  onCrosshairMove?: (t: number) => void;
  onTimeRangeChange?: (range: any, chartId: string) => void;
  externalRange?: any;
  rangeSource?: string | null;
  tool?: string | null;
  magnet?: boolean;
};

export default function ChartPanel({
  panelId,
  symbol,
  timeframe,
  data,
  drawings,
  onAddTrendline,
  onAddRectangle,
  onDeleteDrawing,
  onUpdateDrawing,
  onFocus,
  onSymbolChange,
  onTimeframeChange,
  activeChart,
  setActiveChart,
  onCrosshairMove,
  onTimeRangeChange,
  externalRange,
  rangeSource,
  tool,
  magnet,
}: Props) {
  const chartId = panelId;

  return (
    <div className="chart-panel">
      <div className="chart-panel__drag-handle">
        <select value={symbol} onChange={(e) => onSymbolChange?.(e.target.value)}>
          <option value="nq">NQ</option>
          <option value="es">ES</option>
          <option value="dax">DAX</option>
          <option value="dxy">DXY</option>
          <option value="us10y">US10Y</option>
          <option value="gold">GOLD</option>
        </select>

        <select value={timeframe} onChange={(e) => onTimeframeChange?.(e.target.value as Timeframe)}>
          <option value="15s">15s</option>
          <option value="1m">1m</option>
          <option value="3m">3m</option>
        </select>

        <div style={{ marginLeft: "6px", fontSize: "10px", color: activeChart === chartId ? "#4da3ff" : "#555" }}>
          ●
        </div>

        <button
          className={`chart-panel__focus ${activeChart === chartId ? "chart-panel__focus--active" : ""}`}
          onClick={onFocus}
        >
          ⤢
        </button>
      </div>

      <div className="chart-panel__body">
        <Chart
          data={data}
          chartId={chartId}
          seriesKey={`${symbol}_${timeframe}`}
          drawings={drawings}
          onAddTrendline={(_, line) => onAddTrendline(symbol, line)}
          onAddRectangle={(_, rect) => onAddRectangle(symbol, rect)}
          onDeleteDrawing={
            onDeleteDrawing ? (id) => onDeleteDrawing(symbol, id) : undefined
          }
          onUpdateDrawing={
            onUpdateDrawing
              ? (selection, points) => onUpdateDrawing(symbol, selection, points)
              : undefined
          }
          activeChart={activeChart}
          setActiveChart={setActiveChart}
          onCrosshairMove={onCrosshairMove}
          onTimeRangeChange={onTimeRangeChange}
          externalRange={externalRange}
          rangeSource={rangeSource}
          tool={tool}
          magnet={magnet}
        />
      </div>
    </div>
  );
}
