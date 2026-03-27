type Props = {
  layoutType: string;
  setLayoutType: (layoutType: string) => void;
};

export default function TopBar({
  layoutType,
  setLayoutType,
}: Props) {

  return (
    <div className="top-bar">

      {/* ================= LAYOUT ================= */}
      <div style={{ display: "flex", gap: "6px" }}>
        {["2", "3", "6"].map((l) => (
          <button
            key={l}
            onClick={() => setLayoutType(l)}
            style={{
              padding: "4px 10px",
              borderRadius: "4px",
              border: "1px solid #2a2d34",
              background: layoutType === l ? "#4da3ff" : "transparent",
              color: layoutType === l ? "#fff" : "#ccc",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            {l} Charts
          </button>
        ))}
      </div>

      {/* ================= RIGHT ================= */}
      <div style={{ marginLeft: "auto", fontSize: "12px", color: "#7f8591" }}>
        Trading Platform
      </div>
    </div>
  );
}