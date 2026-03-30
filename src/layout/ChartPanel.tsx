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
  isReplay?: boolean;
  replayIndex?: number;
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
  isReplay,
  replayIndex,
}: Props) {
  const chartId = panelId;
  const hasDrawings =
    drawings.trendlines.length > 0 ||
    drawings.rectangles.length > 0 ||
    drawings.texts.length > 0;

  return (
    <div className="chart-panel">
      <div className="chart-panel__drag-handle">
        {/* Symbol Selector */}
        <div style={{ display: "flex", gap: "2px" }}>
          {["nq", "es"].map((sym) => (
            <button
              key={sym}
              onClick={() => onSymbolChange?.(sym)}
              className={`ui-button ${symbol === sym ? "ui-button--active" : ""}`}
              style={{ height: "24px", padding: "0 8px", fontSize: "11px" }}
            >
              {sym.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Timeframe Selector */}
        <div style={{ display: "flex", gap: "2px", marginLeft: "8px" }}>
          {["15s", "1m", "3m"].map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframeChange?.(tf as Timeframe)}
              className={`ui-button ${timeframe === tf ? "ui-button--active" : ""}`}
              style={{ height: "24px", padding: "0 6px", fontSize: "11px" }}
            >
              {tf}
            </button>
          ))}
        </div>

        <div
          style={{
            marginLeft: "6px",
            fontSize: "10px",
            color: activeChart === chartId ? "var(--panel-accent)" : "var(--panel-muted)",
          }}
          title={activeChart === chartId ? "Active panel" : "Inactive panel"}
        >
          o
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "4px", marginLeft: "8px" }}>
          <button
            type="button"
            onClick={drawingsHidden ? onShowDrawings : onHideDrawings}
            className="ui-button"
            style={{ height: "24px", padding: "0 8px", fontSize: "11px" }}
            title={
              drawingsHidden
                ? "Show drawings for this symbol"
                : "Hide drawings for this symbol"
            }
          >
            {drawingsHidden ? "👁 Show" : "🙈 Hide"}
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
            className={`ui-button ${!hasDrawings ? "ui-button--disabled" : "ui-button--danger"}`}
            style={{ height: "24px", padding: "0 8px", fontSize: "11px", opacity: hasDrawings ? 1 : 0.5, cursor: hasDrawings ? "pointer" : "not-allowed" }}
            title="Delete all drawings for this symbol"
          >
            🗑 Clear
          </button>
        </div>

        <button
          className={`chart-panel__focus ${
            activeChart === chartId ? "chart-panel__focus--active" : ""
          }`}
          onClick={onFocus}
          title="Expand to fullscreen"
        >
          ⬜
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
          isReplay={isReplay}
          replayIndex={replayIndex}
        />
      </div>
    </div>
  );
}
