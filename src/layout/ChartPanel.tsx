import Chart from "../Chart";
import type {
  ChartDrawings,
  Drawing,
  DrawingSelection,
  Rectangle,
  TextDrawing,
  Trendline,
} from "../types/drawings";

type Timeframe = "15s" | "1m" | "3m";

type Props = {
  panelId: string;
  symbol: string;
  timeframe: Timeframe;
  data: any[];
  drawings: ChartDrawings;
  drawingsHidden?: boolean;
  onAddTrendline: (symbol: string, line: Trendline) => void;
  onAddRectangle: (symbol: string, rect: Rectangle) => void;
  onAddText: (symbol: string, text: TextDrawing) => void;
  onDeleteDrawing?: (symbol: string, id: string) => void;
  onUpdateDrawing?: (
    symbol: string,
    selection: DrawingSelection,
    drawing: Drawing
  ) => void;
  onFocus: () => void;
  onSymbolChange?: (symbol: string) => void;
  onTimeframeChange?: (tf: Timeframe) => void;
  activeChart?: string | null;
  setActiveChart?: (id: string) => void;
  tool?: string | null;
  magnet?: boolean;
  onHideDrawings?: () => void;
  onShowDrawings?: () => void;
  onClearDrawings?: () => void;
};

export default function ChartPanel({
  panelId,
  symbol,
  timeframe,
  data,
  drawings,
  drawingsHidden = false,
  onAddTrendline,
  onAddRectangle,
  onAddText,
  onDeleteDrawing,
  onUpdateDrawing,
  onFocus,
  onSymbolChange,
  onTimeframeChange,
  activeChart,
  setActiveChart,
  tool,
  magnet,
  onHideDrawings,
  onShowDrawings,
  onClearDrawings,
}: Props) {
  const chartId = panelId;
  const hasDrawings =
    drawings.trendlines.length > 0 ||
    drawings.rectangles.length > 0 ||
    drawings.texts.length > 0;

  const controlButtonStyle = {
    height: "22px",
    padding: "0 8px",
    border: "1px solid #2a2d34",
    borderRadius: "4px",
    background: "transparent",
    color: "#b8bec8",
    cursor: "pointer",
    fontSize: "10px",
  } as const;

  return (
    <div className="chart-panel">
      <div className="chart-panel__drag-handle">
        <select value={symbol} onChange={(e) => onSymbolChange?.(e.target.value)}>
          <option value="nq">NQ</option>
          <option value="es">ES</option>
        </select>

        <select
          value={timeframe}
          onChange={(e) => onTimeframeChange?.(e.target.value as Timeframe)}
        >
          <option value="15s">15s</option>
          <option value="1m">1m</option>
          <option value="3m">3m</option>
        </select>

        <div
          style={{
            marginLeft: "6px",
            fontSize: "10px",
            color: activeChart === chartId ? "var(--panel-accent)" : "#555",
          }}
          title={activeChart === chartId ? "Active panel" : "Inactive panel"}
        >
          o
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "8px" }}>
          <button
            type="button"
            onClick={drawingsHidden ? onShowDrawings : onHideDrawings}
            style={{
              ...controlButtonStyle,
              color: drawingsHidden ? "#f5a623" : "#b8bec8",
            }}
            title={
              drawingsHidden
                ? "Show drawings for this symbol"
                : "Hide drawings for this symbol"
            }
          >
            {drawingsHidden ? "Show" : "Hide"}
          </button>

          <button
            type="button"
            onClick={() => {
              if (!hasDrawings) return;
              if (window.confirm(`Delete all drawings for ${symbol.toUpperCase()}?`)) {
                onClearDrawings?.();
              }
            }}
            disabled={!hasDrawings}
            style={{
              ...controlButtonStyle,
              color: hasDrawings ? "#d88d8d" : "#6b717c",
              cursor: hasDrawings ? "pointer" : "not-allowed",
              opacity: hasDrawings ? 1 : 0.65,
            }}
            title="Delete all drawings for this symbol"
          >
            Clear
          </button>
        </div>

        <button
          className={`chart-panel__focus ${
            activeChart === chartId ? "chart-panel__focus--active" : ""
          }`}
          onClick={onFocus}
        >
          []
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
          onAddText={(_, text) => onAddText(symbol, text)}
          onDeleteDrawing={
            onDeleteDrawing ? (id) => onDeleteDrawing(symbol, id) : undefined
          }
          onUpdateDrawing={
            onUpdateDrawing
              ? (selection, drawing) => onUpdateDrawing(symbol, selection, drawing)
              : undefined
          }
          activeChart={activeChart}
          setActiveChart={setActiveChart}
          tool={tool}
          magnet={magnet}
          hidden={drawingsHidden}
        />
      </div>
    </div>
  );
}
