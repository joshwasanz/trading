import Chart from "../Chart";

type Props = {
  symbol: string;
  data: any[];
  onFocus: () => void;
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
  activeChart,
  setActiveChart,
  onCrosshairMove,
  externalTime,
  onTimeRangeChange,
  externalRange,
}: Props) {
  return (
    <div
      className="chart-panel"
      style={{
        background: "#151518",
        borderRadius: "8px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        border: "1px solid #2a2a2e",
        overflow: "hidden",
      }}
    >
      {/* Header / drag handle */}
      <div
        className="chart-panel__drag-handle"
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid #2a2a2e",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "12px",
          color: "#ccc",
          userSelect: "none",
          flexShrink: 0,
          cursor: "move",
        }}
      >
        <span 
          style={{ fontWeight: 600, letterSpacing: "0.05em" }}
        >
          {symbol.toUpperCase()}
        </span>
        <button
          className="chart-panel__focus"
          onClick={onFocus}
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            background: "none",
            border: activeChart === symbol ? "1px solid #4da3ff" : "1px solid #2a2a2e",
            color: "#888",
            cursor: "pointer",
            fontSize: "14px",
            padding: "0 4px",
          }}
        >
          ⤢
        </button>
      </div>

      {/* Chart */}
      <div
        className="chart-panel__body"
        style={{ 
          flex: 1, 
          overflow: "hidden",
          touchAction: "manipulation"
        }}
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
