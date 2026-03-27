import { useState } from "react";
import ChartPanel from "./ChartPanel";

type Timeframe = "15s" | "1m" | "3m";

export default function LayoutManager({
  data,
  layoutType,
  activeChart,
  setActiveChart,
  crosshairTime,
  setCrosshairTime,
  timeRange,
  setTimeRange,
  tool, // 🔥 NEW
}: any) {

  const [vSplit, setVSplit] = useState(0.5);
  const [hSplit, setHSplit] = useState(0.5);

  // 🔥 PANEL STATE
  const [panels, setPanels] = useState({
    A: { symbol: "nq", timeframe: "15s" as Timeframe },
    B: { symbol: "es", timeframe: "15s" as Timeframe },
    C: { symbol: "dxy", timeframe: "15s" as Timeframe },
  });

  const [focused, setFocused] = useState<string | null>(null);

  const sharedProps = {
    activeChart,
    setActiveChart,
    onCrosshairMove: (t: number) => setCrosshairTime(t),
    externalTime: crosshairTime,
    onTimeRangeChange: (r: any) => setTimeRange(r),
    externalRange: timeRange,
    tool, // 🔥 PASS TOOL DOWN
  };

  // ==================== PANEL UPDATE ====================
  const updatePanel = (key: "A" | "B" | "C", updates: any) => {
    setPanels((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...updates },
    }));
  };

  // ==================== RESIZE ====================

  const startVerticalResize = (e: React.MouseEvent) => {
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      const newSplit = ev.clientX / window.innerWidth;
      setVSplit(Math.max(0.2, Math.min(0.8, newSplit)));
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
      const newSplit = ev.clientY / window.innerHeight;
      setHSplit(Math.max(0.2, Math.min(0.8, newSplit)));
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
    const panel = panels[focused as "A" | "B" | "C"];

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
            onSymbolChange={(s) => updatePanel(focused as any, { symbol: s })}
            onTimeframeChange={(tf) => updatePanel(focused as any, { timeframe: tf })}
            {...sharedProps}
          />
        </div>
      </div>
    );
  }

  // ==================== 2 PANEL ====================

  if (layoutType === "2") {
    return (
      <div className="layout-engine">

        <div style={{ position: "absolute", left: 0, top: 0, width: `${vSplit * 100}%`, height: "100%" }}>
          <ChartPanel
            symbol={panels.A.symbol}
            timeframe={panels.A.timeframe}
            data={data[panels.A.symbol]?.[panels.A.timeframe] || []}
            onFocus={() => setFocused("A")}
            onSymbolChange={(s) => updatePanel("A", { symbol: s })}
            onTimeframeChange={(tf) => updatePanel("A", { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: `${(1 - vSplit) * 100}%`, height: "100%" }}>
          <ChartPanel
            symbol={panels.B.symbol}
            timeframe={panels.B.timeframe}
            data={data[panels.B.symbol]?.[panels.B.timeframe] || []}
            onFocus={() => setFocused("B")}
            onSymbolChange={(s) => updatePanel("B", { symbol: s })}
            onTimeframeChange={(tf) => updatePanel("B", { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        <div
          onMouseDown={startVerticalResize}
          style={{
            position: "absolute",
            left: `${vSplit * 100}%`,
            top: 0,
            width: "6px",
            height: "100%",
            cursor: "col-resize",
            zIndex: 50,
            transform: "translateX(-3px)",
          }}
        />
      </div>
    );
  }

  // ==================== 3 PANEL ====================

  if (layoutType === "3") {
    return (
      <div className="layout-engine">

        {/* LEFT */}
        <div style={{ position: "absolute", left: 0, top: 0, width: `${vSplit * 100}%`, height: "100%" }}>
          <ChartPanel
            symbol={panels.A.symbol}
            timeframe={panels.A.timeframe}
            data={data[panels.A.symbol]?.[panels.A.timeframe] || []}
            onFocus={() => setFocused("A")}
            onSymbolChange={(s) => updatePanel("A", { symbol: s })}
            onTimeframeChange={(tf) => updatePanel("A", { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        {/* TOP RIGHT */}
        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: `${(1 - vSplit) * 100}%`, height: `${hSplit * 100}%` }}>
          <ChartPanel
            symbol={panels.B.symbol}
            timeframe={panels.B.timeframe}
            data={data[panels.B.symbol]?.[panels.B.timeframe] || []}
            onFocus={() => setFocused("B")}
            onSymbolChange={(s) => updatePanel("B", { symbol: s })}
            onTimeframeChange={(tf) => updatePanel("B", { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        {/* BOTTOM RIGHT */}
        <div style={{ position: "absolute", left: `${vSplit * 100}%`, top: `${hSplit * 100}%`, width: `${(1 - vSplit) * 100}%`, height: `${(1 - hSplit) * 100}%` }}>
          <ChartPanel
            symbol={panels.C.symbol}
            timeframe={panels.C.timeframe}
            data={data[panels.C.symbol]?.[panels.C.timeframe] || []}
            onFocus={() => setFocused("C")}
            onSymbolChange={(s) => updatePanel("C", { symbol: s })}
            onTimeframeChange={(tf) => updatePanel("C", { timeframe: tf })}
            {...sharedProps}
          />
        </div>

        {/* DIVIDERS */}
        <div onMouseDown={startVerticalResize} style={{ position: "absolute", left: `${vSplit * 100}%`, top: 0, width: "6px", height: "100%", cursor: "col-resize", transform: "translateX(-3px)" }} />
        <div onMouseDown={startHorizontalResize} style={{ position: "absolute", left: `${vSplit * 100}%`, top: `${hSplit * 100}%`, width: `${(1 - vSplit) * 100}%`, height: "6px", cursor: "row-resize", transform: "translateY(-3px)" }} />
      </div>
    );
  }

  // ==================== 6 PANEL ====================

  if (layoutType === "6") {
    return (
      <div className="layout-engine">

        {[0, 1, 2].map((i) => (
          <div key={`top-${i}`} style={{
            position: "absolute",
            left: `${i * 33.33}%`,
            top: 0,
            width: "33.33%",
            height: "50%",
          }}>
            <ChartPanel
              symbol={panels[["A","B","C"][i] as "A"|"B"|"C"].symbol}
              timeframe={panels[["A","B","C"][i] as "A"|"B"|"C"].timeframe}
              data={data[panels[["A","B","C"][i] as "A"|"B"|"C"].symbol]?.[panels[["A","B","C"][i] as "A"|"B"|"C"].timeframe] || []}
              onFocus={() => setFocused(["A","B","C"][i])}
              {...sharedProps}
            />
          </div>
        ))}

        {[0, 1, 2].map((i) => (
          <div key={`bottom-${i}`} style={{
            position: "absolute",
            left: `${i * 33.33}%`,
            top: "50%",
            width: "33.33%",
            height: "50%",
          }}>
            <ChartPanel
              symbol={panels[["A","B","C"][i] as "A"|"B"|"C"].symbol}
              timeframe={panels[["A","B","C"][i] as "A"|"B"|"C"].timeframe}
              data={data[panels[["A","B","C"][i] as "A"|"B"|"C"].symbol]?.[panels[["A","B","C"][i] as "A"|"B"|"C"].timeframe] || []}
              onFocus={() => setFocused(["A","B","C"][i])}
              {...sharedProps}
            />
          </div>
        ))}

      </div>
    );
  }

  return null;
}