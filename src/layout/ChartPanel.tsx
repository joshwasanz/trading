import Chart from "../Chart";
import type { Candle, HistoryUiState, SupportedSymbol, Timeframe } from "../types/marketData";
import type { ReplayStartPayload } from "../types/replay";
import { filterSupportedTimeframesForInstrument } from "../instruments";
import type {
  ChartDrawings,
  Drawing,
  DrawingSelection,
  Rectangle,
  TextDrawing,
  Trendline,
} from "../types/drawings";

type Props = {
  panelId: string;
  symbol: string;
  timeframe: Timeframe;
  data: Candle[];
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
  onPreviewDrawing?: (
    symbol: string,
    selection: DrawingSelection,
    drawing: Drawing
  ) => void;
  onCommitPreviewDrawing?: (
    symbol: string,
    selection: DrawingSelection,
    previousDrawing: Drawing,
    nextDrawing: Drawing
  ) => void;
  onFocus: () => void;
  supportedSymbols?: SupportedSymbol[];
  supportedTimeframes?: Timeframe[];
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
  isReplaySelectingStart?: boolean;
  replaySelectionPanelId?: string | null;
  replayStartTime?: number | null;
  replayCursorTime?: number | null;
  replayIndex?: number;
  isReplaySync?: boolean;
  onReplayStart?: (payload: ReplayStartPayload) => void;
  historyUiState?: HistoryUiState;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  showSessions?: boolean;
  showSessionLevels?: boolean;
  showSessionRanges?: boolean;
  showSma?: boolean;
  smaPeriod?: number;
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
  onPreviewDrawing,
  onCommitPreviewDrawing,
  onFocus,
  supportedSymbols = [],
  supportedTimeframes = ["1m", "3m"],
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
  isReplaySelectingStart,
  replaySelectionPanelId,
  replayStartTime,
  replayCursorTime,
  replayIndex,
  isReplaySync,
  onReplayStart,
  historyUiState,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  showSessions = true,
  showSessionLevels = true,
  showSessionRanges = true,
  showSma = false,
  smaPeriod = 20,
}: Props) {
  const chartId = panelId;
  const symbolOptions = supportedSymbols.some((candidate) => candidate.id === symbol)
    ? supportedSymbols
    : [{ id: symbol, label: symbol.toUpperCase() }, ...supportedSymbols];
  const timeframeOptions = filterSupportedTimeframesForInstrument(symbol, supportedTimeframes);
  const hasDrawings =
    drawings.trendlines.length > 0 ||
    drawings.rectangles.length > 0 ||
    drawings.texts.length > 0;

  return (
    <div className="chart-panel">
      <div className="chart-panel__drag-handle">
        {/* Symbol Selector */}
        <div style={{ display: "flex", gap: "2px" }}>
          {symbolOptions.map((supportedSymbol) => (
            <button
              key={supportedSymbol.id}
              onClick={() => onSymbolChange?.(supportedSymbol.id)}
              className={`ui-button ${symbol === supportedSymbol.id ? "ui-button--active" : ""}`}
              style={{ height: "24px", padding: "0 8px", fontSize: "11px" }}
              title={supportedSymbol.label}
            >
              {supportedSymbol.id.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Timeframe Selector */}
        <div style={{ display: "flex", gap: "2px", marginLeft: "8px" }}>
          {timeframeOptions.map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframeChange?.(tf)}
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
          symbol={symbol}
          timeframe={timeframe}
          drawings={drawings}
          onAddTrendline={(line) => onAddTrendline(symbol, line)}
          onAddRectangle={(rect) => onAddRectangle(symbol, rect)}
          onAddText={(text) => onAddText(symbol, text)}
          onDeleteDrawing={
            onDeleteDrawing ? (id) => onDeleteDrawing(symbol, id) : undefined
          }
          onUpdateDrawing={
            onUpdateDrawing
              ? (selection, drawing) => onUpdateDrawing(symbol, selection, drawing)
              : undefined
          }
          onPreviewDrawing={
            onPreviewDrawing
              ? (selection, drawing) => onPreviewDrawing(symbol, selection, drawing)
              : undefined
          }
          onCommitPreviewDrawing={
            onCommitPreviewDrawing
              ? (selection, previousDrawing, nextDrawing) =>
                  onCommitPreviewDrawing(symbol, selection, previousDrawing, nextDrawing)
              : undefined
          }
          activeChart={activeChart}
          setActiveChart={setActiveChart}
          tool={tool}
          magnet={magnet}
          hidden={drawingsHidden}
          isReplay={isReplay}
          isReplaySelectingStart={isReplaySelectingStart}
          replaySelectionPanelId={replaySelectionPanelId}
          replayStartTime={replayStartTime}
          replayCursorTime={replayCursorTime}
          replayIndex={replayIndex}
          isReplaySync={isReplaySync}
          onReplayStart={onReplayStart}
          historyUiState={historyUiState}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          showSessions={showSessions}
          showSessionLevels={showSessionLevels}
          showSessionRanges={showSessionRanges}
          showSma={showSma}
          smaPeriod={smaPeriod}
        />
      </div>
    </div>
  );
}
