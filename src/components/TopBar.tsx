import { useThemeStore } from "../store/useThemeStore";

type Props = {
  layoutType: string;
  setLayoutType: (layoutType: string) => void;
};

export default function TopBar({
  layoutType,
  setLayoutType,
}: Props) {
  const { mode, setMode, preset, setPreset } = useThemeStore();

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
              background: layoutType === l ? "var(--panel-accent)" : "transparent",
              color: layoutType === l ? "#fff" : "#ccc",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            {l} Charts
          </button>
        ))}
      </div>

      {/* ================= THEME & PRESET ================= */}
      <div style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
        {/* Theme Toggle */}
        <button
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
          style={{
            padding: "4px 10px",
            borderRadius: "4px",
            border: "1px solid var(--panel-border)",
            background: "transparent",
            color: "var(--panel-muted)",
            cursor: "pointer",
            fontSize: "12px",
            transition: "all 0.2s",
          }}
          title={mode === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
        >
          {mode === "dark" ? "☀️" : "🌙"}
        </button>

        {/* Theme Preset Selector */}
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as "professional" | "premium" | "vibrant" | "monochrome" | "gold" | "ict")}
          style={{
            padding: "4px 6px",
            borderRadius: "4px",
            border: "1px solid var(--panel-border)",
            background: "var(--panel-bg)",
            color: "var(--panel-text)",
            cursor: "pointer",
            fontSize: "12px",
          }}
          title="Select theme preset"
        >
          <option value="professional">Professional</option>
          <option value="premium">Premium</option>
          <option value="vibrant">Vibrant</option>
          <option value="monochrome">Monochrome</option>
          <option value="gold">Gold</option>
          <option value="ict">ICT</option>
        </select>

        <div style={{ marginLeft: "12px", fontSize: "12px", color: "var(--panel-muted)" }}>
          Trading Platform
        </div>
      </div>
    </div>
  );
}