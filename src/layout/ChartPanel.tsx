import Chart from "../Chart";

type Props = {
  symbol: string;
  data: any[];
  onFocus: () => void;
  onSymbolChange?: (symbol: string) => void;
  activeChart?: string | null;
  setActiveChart?: (s: string) => void;
  onCrosshairMove?: (t: number) => void;
  externalTime?: number | null;
  onTimeRangeChange?: (r: any, s: string) => void;
  externalRange?: any;
};

export default function ChartPanel({
  symbol,
  data,
  onFocus,
  onSymbolChange,
  activeChart,
  setActiveChart,
  onCrosshairMove,
  externalTime,
  onTimeRangeChange,
  externalRange,
}: Props) {
  return (
    <div className="chart-panel">
      {/* Header / drag handle */}
      <div className="chart-panel__drag-handle">
        <select
          value={symbol}
          onChange={(e) => onSymbolChange?.(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <option value="nq">NQ</option>
          <option value="es">ES</option>
          <option value="dax">DAX</option>
          <option value="dxy">DXY</option>
          <option value="us10y">US10Y</option>
          <option value="gold">GOLD</option>
        </select>
        <button
          className="chart-panel__focus"
          onClick={onFocus}
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            borderColor: activeChart === symbol ? "#4da3ff" : "#2a2a2e",
          }}
        >
          ⤢
        </button>
      </div>

      {/* Chart */}
      <div
        className="chart-panel__body"
        onMouseDown={(e) => {
          // Prevent grid dragging when clicking on chart area
          if (e.target !== e.currentTarget) {
            e.stopPropagation();
          }
        }}
        onTouchStart={(e) => {
          // Prevent grid dragging on touch interactions with chart
          if (e.target !== e.currentTarget) {
            e.stopPropagation();
          }
        }}
      >
        <Chart
          symbol={symbol}
          data={data}
          activeChart={activeChart}
          setActiveChart={setActiveChart}
          onCrosshairMove={onCrosshairMove}
          externalTime={externalTime}
          onTimeRangeChange={onTimeRangeChange}
          externalRange={externalRange}
        />
      </div>
    </div>
  );
}
