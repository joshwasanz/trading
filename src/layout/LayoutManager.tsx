import GridLayout from "react-grid-layout";
import { useState } from "react";
import ChartPanel from "./ChartPanel";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

export default function LayoutManager({ data, activeChart, setActiveChart, crosshairTime, setCrosshairTime, timeRange, setTimeRange }: any) {
  const [focused, setFocused] = useState<string | null>(null);
  const [layout, setLayout] = useState([
    { i: "nq", x: 0, y: 0, w: 6, h: 4 },
    { i: "es", x: 6, y: 0, w: 6, h: 4 },
  ]);
  const gridInteractionProps = {
    draggableHandle: ".chart-panel__drag-handle",
  } as any;

  const sharedProps = {
    activeChart,
    setActiveChart,
    onCrosshairMove: (t: number) => setCrosshairTime(t),
    externalTime: crosshairTime,
    onTimeRangeChange: (r: any) => setTimeRange(r),
    externalRange: timeRange,
  };

  if (focused) {
    return (
      <div style={{ width: "100vw", height: "100vh", background: "#0e0e11", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #2a2a2e", zIndex: 10 }}>
          <button
            onClick={() => setFocused(null)}
            style={{ background: "none", border: "1px solid #2a2a2e", color: "#ccc", padding: "4px 12px", borderRadius: "4px", cursor: "pointer" }}
          >
            ← Back
          </button>
        </div>
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <ChartPanel
            symbol={focused}
            data={data[focused]}
            onFocus={() => setFocused(null)}
            {...sharedProps}
          />
        </div>
      </div>
    );
  }

  return (
    <GridLayout
      className="layout"
      layout={layout}
      width={window.innerWidth - 20}
      {...gridInteractionProps}
      onLayoutChange={(l) => setLayout([...l])}
    >
      {["nq", "es"].map((sym) => (
        <div key={sym}>
          <ChartPanel
            symbol={sym}
            data={data[sym]}
            onFocus={() => setFocused(sym)}
            {...sharedProps}
          />
        </div>
      ))}
    </GridLayout>
  );
}
