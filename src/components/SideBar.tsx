import { useState } from "react";
import { useToolStore, type ToolType } from "../store/useToolStore";

type HoverItem = ToolType | "magnet";

export default function Sidebar() {
  const tool = useToolStore((state) => state.tool);
  const setTool = useToolStore((state) => state.setTool);
  const magnet = useToolStore((state) => state.magnet);
  const setMagnet = useToolStore((state) => state.setMagnet);
  const [hoveredItem, setHoveredItem] = useState<HoverItem | null>(null);

  const toolNames: Record<ToolType, string> = {
    trendline: "Trendline",
    rectangle: "Rectangle",
    text: "Text",
    none: "Pointer",
  };

  const tooltipLabel =
    hoveredItem === "magnet"
        ? magnet
          ? "Magnet On"
          : "Magnet Off"
      : hoveredItem
        ? toolNames[hoveredItem]
        : null;

  const Button = ({
    value,
    label,
  }: {
    value: ToolType;
    label: string;
  }) => (
    <div style={{ position: "relative" }}>
      <button
        onMouseDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          setTool(value);
        }}
        onMouseEnter={() => setHoveredItem(value)}
        onMouseLeave={() => setHoveredItem(null)}
        className={`ui-button ${tool === value ? "ui-button--active" : ""}`}
        title={toolNames[value]}
      >
        {label}
      </button>

      {hoveredItem === value && tooltipLabel && (
        <div
          style={{
            position: "absolute",
            left: "42px",
            top: "50%",
            transform: "translateY(-50%)",
            background: "var(--panel-bg)",
            color: "var(--panel-text)",
            padding: "4px 8px",
            borderRadius: "4px",
            fontSize: "12px",
            whiteSpace: "nowrap",
            border: "1px solid var(--panel-border)",
            zIndex: 1000,
          }}
        >
          {tooltipLabel}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="sidebar"
      style={{
        width: "48px",
        background: "var(--panel-bg)",
        borderRight: "1px solid var(--panel-border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: "10px",
        gap: "10px",
        paddingBottom: "10px",
      }}
    >
      <Button value="trendline" label="/" />
      <Button value="rectangle" label="[]" />
      <Button value="text" label="T" />
      <Button value="none" label="X" />

      <div style={{ position: "relative" }}>
        <button
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMagnet(!magnet);
          }}
          onMouseEnter={() => setHoveredItem("magnet")}
          onMouseLeave={() => setHoveredItem(null)}
          className={`ui-button ${magnet ? "ui-button--active" : ""}`}
          title={magnet ? "Magnet On" : "Magnet Off"}
        >
          M
        </button>

        {hoveredItem === "magnet" && tooltipLabel && (
          <div
            style={{
              position: "absolute",
              left: "42px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "var(--panel-bg)",
              color: "var(--panel-text)",
              padding: "4px 8px",
              borderRadius: "4px",
              fontSize: "12px",
              whiteSpace: "nowrap",
              border: "1px solid var(--panel-border)",
              zIndex: 1000,
            }}
          >
            {tooltipLabel}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: "auto",
          fontSize: "10px",
          color: "var(--panel-muted)",
          textAlign: "center",
          padding: "8px 4px",
          borderTop: "1px solid var(--panel-border)",
          width: "100%",
          lineHeight: 1.4,
        }}
      >
        <div>{toolNames[tool]}</div>
        <div>{magnet ? "Magnet" : "Free"}</div>
      </div>
    </div>
  );
}
