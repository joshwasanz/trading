import { useState } from "react";
import ChartPanel from "./ChartPanel";

type Timeframe = "15s" | "1m" | "3m";

type Panel = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
};

const DEFAULT_PANELS: Panel[] = [
  { id: "A", symbol: "nq", timeframe: "15s" },
  { id: "B", symbol: "es", timeframe: "15s" },
  { id: "C", symbol: "dxy", timeframe: "15s" },
  { id: "D", symbol: "nq", timeframe: "1m" },
  { id: "E", symbol: "es", timeframe: "1m" },
  { id: "F", symbol: "dxy", timeframe: "1m" },
];

export default function LayoutManager({
  data,
  layoutType,
  activeChart,
  setActiveChart,
  crosshairTime,
  setCrosshairTime,
  timeRange,
  setTimeRange,
  rangeSource,
  setRangeSource,
  tool,
}: any) {
  const [vSplit, setVSplit] = useState(0.5);
  const [hSplit, setHSplit] = useState(0.5);
  const [panels, setPanels] = useState<Panel[]>(DEFAULT_PANELS);
  const [focused, setFocused] = useState<string | null>(null);

  const sharedProps = {
    activeChart,
    setActiveChart,
    onCrosshairMove: (t: number) => setCrosshairTime(t),
    externalTime: crosshairTime,
    onTimeRangeChange: (r: any, sourceChartId: string) => {
      setTimeRange(r);
      setRangeSource(sourceChartId);
    },
    externalRange: timeRange,
    rangeSource,
    tool,
  };

  // ==================== PANEL UPDATE ====================
  const updatePanel = (id: string, updates: Partial<Panel>) => {
    setPanels((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
    );
  };

  const getPanel = (id: string) => panels.find((p) => p.id === id)!;

  // ==================== RESIZE ====================
  const startVerticalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setVSplit(Math.max(0.2, Math.min(0.8, ev.clientX / window.innerWidth)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startHorizontalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setHSplit(Math.max(0.2, Math.min(0.8, ev.clientY / window.innerHeight)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ==================== FOCUS MODE ====================
  if (focused) {
    const panel = getPanel(focused);
    return (
      <div className="focus-mode">
        <div className="focus-mode__header">
          <button onClick={() => setFocused(null)}>← Back</button>
        </div>
        <div className="focus-mode__content">
          <ChartPanel
            symbol={panel.symbol}
            timeframe={panel.timeframe}
            data={data[panel.symbol]?.[panel.timeframe] || []}
            onFocus={() => setFocused(null)}
            onSymbolChange={(s) => updatePanel(focused, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(focused, { timeframe: tf })}
            {...sharedProps}
          />
        </div>
      </div>
    );
  }

  // ==================== 2 PANEL ====================
  if (layoutType === "2") {
    const [p0, p1] = panels;
    return (
      <div className="layout-engine">
        <div style={{ position: "absolute", left: 0, top: 0, width: `${vSplit * 100}%`, height: "100%" }}>
          <ChartPanel
            symbol={p0.symbol}
            timeframe={p0.timeframe}
            data={data[p0.symbol]?.[p0.timeframe] || []}
            onFocus={() => setFocused(p0.id)}
            onSymbolChange={(s) => updatePanel(p0.id, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(p0.id, { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: `${(1 - vSplit) * 100}%`, height: "100%" }}>
          <ChartPanel
            symbol={p1.symbol}
            timeframe={p1.timeframe}
            data={data[p1.symbol]?.[p1.timeframe] || []}
            onFocus={() => setFocused(p1.id)}
            onSymbolChange={(s) => updatePanel(p1.id, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(p1.id, { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div
          onMouseDown={startVerticalResize}
          style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: "6px", height: "100%", cursor: "col-resize", zIndex: 50, transform: "translateX(-3px)" }}
        />
      </div>
    );
  }

  // ==================== 3 PANEL ====================
  if (layoutType === "3") {
    const [p0, p1, p2] = panels;
    return (
      <div className="layout-engine">
        <div style={{ position: "absolute", left: 0, top: 0, width: `${vSplit * 100}%`, height: "100%" }}>
          <ChartPanel
            symbol={p0.symbol}
            timeframe={p0.timeframe}
            data={data[p0.symbol]?.[p0.timeframe] || []}
            onFocus={() => setFocused(p0.id)}
            onSymbolChange={(s) => updatePanel(p0.id, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(p0.id, { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: `${(1 - vSplit) * 100}%`, height: `${hSplit * 100}%` }}>
          <ChartPanel
            symbol={p1.symbol}
            timeframe={p1.timeframe}
            data={data[p1.symbol]?.[p1.timeframe] || []}
            onFocus={() => setFocused(p1.id)}
            onSymbolChange={(s) => updatePanel(p1.id, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(p1.id, { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: `${hSplit * 100}%`, width: `${(1 - vSplit) * 100}%`, height: `${(1 - hSplit) * 100}%` }}>
          <ChartPanel
            symbol={p2.symbol}
            timeframe={p2.timeframe}
            data={data[p2.symbol]?.[p2.timeframe] || []}
            onFocus={() => setFocused(p2.id)}
            onSymbolChange={(s) => updatePanel(p2.id, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(p2.id, { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div onMouseDown={startVerticalResize} style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: "6px", height: "100%", cursor: "col-resize", transform: "translateX(-3px)", zIndex: 50 }} />
        <div onMouseDown={startHorizontalResize} style={{ position: "absolute", left: `${vSplit * 100}%`, top: `${hSplit * 100}%`, width: `${(1 - vSplit) * 100}%`, height: "6px", cursor: "row-resize", transform: "translateY(-3px)", zIndex: 50 }} />
      </div>
    );
  }

  // ==================== 6 PANEL ====================
  if (layoutType === "6") {
    return (
      <div className="layout-engine">
        {panels.map((panel, i) => (
          <div
            key={panel.id}
            style={{
              position: "absolute",
              left: `${(i % 3) * 33.33}%`,
              top: i < 3 ? "0%" : "50%",
              width: "33.33%",
              height: "50%",
            }}
          >
            <ChartPanel
              symbol={panel.symbol}
              timeframe={panel.timeframe}
              data={data[panel.symbol]?.[panel.timeframe] || []}
              onFocus={() => setFocused(panel.id)}
              onSymbolChange={(s) => updatePanel(panel.id, { symbol: s })}
              onTimeframeChange={(tf) => updatePanel(panel.id, { timeframe: tf })}
              {...sharedProps}
            />
          </div>
        ))}
      </div>
    );
  }

  return null;
}
