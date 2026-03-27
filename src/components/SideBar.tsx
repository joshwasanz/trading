import { useState } from "react";
import { useToolStore, ToolType } from "../store/useToolStore";

export default function Sidebar() {
  const tool = useToolStore((s) => s.tool);
  const setTool = useToolStore((s) => s.setTool);
  const [hoveredTool, setHoveredTool] = useState<ToolType | null>(null);

  const toolNames: Record<ToolType, string> = {
    trendline: "Trendline",
    rectangle: "Rectangle",
    none: "Pointer",
  };

  const Button = ({
    value,
    label,
  }: {
    value: ToolType;
    label: string;
  }) => (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setTool(value)}
        onMouseEnter={() => setHoveredTool(value)}
        onMouseLeave={() => setHoveredTool(null)}
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

      {/* TOOLTIP */}
      {hoveredTool === value && (
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
          {toolNames[value]}
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
      <Button value="rectangle" label="▭" />
      <Button value="none" label="✕" />

      {/* CURRENT TOOL LABEL */}
      <div
        style={{
          marginTop: "auto",
          fontSize: "10px",
          color: "#7f8591",
          textAlign: "center",
          padding: "8px 4px",
          borderTop: "1px solid #2a2d34",
          width: "100%",
        }}
      >
        {toolNames[tool]}
      </div>
    </div>
  );
}