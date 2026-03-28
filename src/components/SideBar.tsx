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
        style={{
          width: "32px",
          height: "32px",
          background: tool === value ? "#4da3ff" : "transparent",
          color: tool === value ? "#fff" : "#aaa",
          border: "1px solid #2a2d34",
          borderRadius: "4px",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
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
            background: "#1a1a1f",
            color: "#d4d7de",
            padding: "4px 8px",
            borderRadius: "4px",
            fontSize: "12px",
            whiteSpace: "nowrap",
            border: "1px solid #2a2d34",
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
      style={{
        width: "48px",
        background: "#0e0e11",
        borderRight: "1px solid #2a2d34",
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
          style={{
            width: "32px",
            height: "32px",
            background: magnet ? "#f5a623" : "transparent",
            border: "1px solid #2a2d34",
            borderRadius: "4px",
            color: magnet ? "#fff" : "#aaa",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
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
              background: "#1a1a1f",
              color: "#d4d7de",
              padding: "4px 8px",
              borderRadius: "4px",
              fontSize: "12px",
              whiteSpace: "nowrap",
              border: "1px solid #2a2d34",
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
          color: "#7f8591",
          textAlign: "center",
          padding: "8px 4px",
          borderTop: "1px solid #2a2d34",
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
