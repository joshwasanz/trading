import GridLayout from "react-grid-layout";
import { useEffect, useMemo, useRef, useState } from "react";
import ChartPanel from "./ChartPanel";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

function defaultSymbolForItem(itemId: string) {
  return itemId.includes("es") ? "es" : "nq";
}

export default function LayoutManager({
  data,
  layoutType,
  activeChart,
  setActiveChart,
  crosshairTime,
  setCrosshairTime,
  timeRange,
  setTimeRange,
}: any) {
  const [focused, setFocused] = useState<string | null>(null);
  const [chartConfigs, setChartConfigs] = useState<any>({});
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });

  const layoutConfigs = {
    "2": {
      cols: 12,
      items: [
        { i: "nq", x: 0, y: 0, w: 6, h: 4 },
        { i: "es", x: 6, y: 0, w: 6, h: 4 },
      ],
    },
    "4": {
      cols: 12,
      items: [
        { i: "nq", x: 0, y: 0, w: 6, h: 4 },
        { i: "es", x: 6, y: 0, w: 6, h: 4 },
        { i: "nq2", x: 0, y: 4, w: 6, h: 4 },
        { i: "es2", x: 6, y: 4, w: 6, h: 4 },
      ],
    },
    "6": {
      cols: 12,
      items: [
        { i: "nq", x: 0, y: 0, w: 4, h: 4 },
        { i: "es", x: 4, y: 0, w: 4, h: 4 },
        { i: "nq2", x: 8, y: 0, w: 4, h: 4 },
        { i: "es2", x: 0, y: 4, w: 4, h: 4 },
        { i: "nq3", x: 4, y: 4, w: 4, h: 4 },
        { i: "es3", x: 8, y: 4, w: 4, h: 4 },
      ],
    },
  };

  const currentConfig = useMemo(() => {
    return (
      layoutConfigs[layoutType as keyof typeof layoutConfigs] ||
      layoutConfigs["2"]
    );
  }, [layoutType]);

  const layout = currentConfig.items;
  const gridMargin: [number, number] = [8, 8];
  const gridPadding: [number, number] = [8, 8];

  useEffect(() => {
    if (!gridContainerRef.current) return;

    const container = gridContainerRef.current;
    const updateSize = () => {
      setGridSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const maxGridUnits = useMemo(() => {
    return layout.reduce(
      (max, item) => Math.max(max, item.y + item.h),
      0
    );
  }, [layout]);

  const rowHeight = useMemo(() => {
    if (gridSize.height <= 0 || maxGridUnits === 0) {
      return 60;
    }

    const verticalMargins = gridMargin[1] * Math.max(maxGridUnits - 1, 0);
    const verticalPadding = gridPadding[1] * 2;
    const availableHeight = Math.max(
      gridSize.height - verticalMargins - verticalPadding,
      maxGridUnits
    );

    return Math.max(40, Math.floor(availableHeight / maxGridUnits));
  }, [gridSize.height, maxGridUnits]);

  useEffect(() => {
    setChartConfigs((prev: any) => {
      const updated = { ...prev };
      let changed = false;

      layout.forEach((item: any) => {
        if (!updated[item.i]) {
          updated[item.i] = defaultSymbolForItem(item.i);
          changed = true;
        }
      });

      return changed ? updated : prev;
    });
  }, [layout]);

  const sharedProps = {
    activeChart,
    setActiveChart,
    onCrosshairMove: (t: number) => setCrosshairTime(t),
    externalTime: crosshairTime,
    onTimeRangeChange: (r: any) => setTimeRange(r),
    externalRange: timeRange,
  };
  const gridSizingProps = {
    autoSize: false,
    rowHeight,
    margin: gridMargin,
    containerPadding: gridPadding,
  } as any;

  if (focused) {
    const focusedSymbol = chartConfigs[focused] ?? defaultSymbolForItem(focused);
    const chartData = data?.[focusedSymbol] || [];

    return (
      <div className="focus-mode">
        <div className="focus-mode__header">
          <button
            onClick={() => setFocused(null)}
            className="focus-mode__back-btn"
          >
            ← Back
          </button>
        </div>

        <div className="focus-mode__content">
          <ChartPanel
            symbol={focusedSymbol}
            data={chartData}
            onFocus={() => setFocused(null)}
            {...sharedProps}
          />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div
        style={{ background: "#0e0e11", width: "100%", height: "100vh" }}
      />
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        ref={gridContainerRef}
        style={{ flex: 1, overflow: "hidden", width: "100%", minHeight: 0 }}
      >
        <GridLayout
          key={`layout-${layoutType}`}
          className="layout"
          layout={layout}
          width={Math.max(gridSize.width, 1)}
          draggableHandle=".chart-panel__drag-handle" 
          {...gridSizingProps}
        >
        {layout.map((item) => {
          const symbol = chartConfigs[item.i] ?? defaultSymbolForItem(item.i);
          const chartData = data?.[symbol] ?? [];

          return (
            <div
              key={item.i}
              style={{
                background: "#151518",
                borderRadius: "8px",
                border: "1px solid #2a2a2e",
                overflow: "hidden",
              }}
            >
              <ChartPanel
                symbol={symbol}
                data={chartData}
                onFocus={() => setFocused(item.i)}
                onSymbolChange={(newSymbol: string) => {
                  setChartConfigs((prev: any) => ({
                    ...prev,
                    [item.i]: newSymbol,
                  }));
                }}
                {...sharedProps}
              />
            </div>
          );
        })}
      </GridLayout>
      </div>
    </div>
  );
}
