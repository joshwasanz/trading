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
      <select
        value={layoutType}
        onChange={(e) => setLayoutType(e.target.value)}
        className="ui-dropdown"
        title="Select layout"
      >
        <option value="2">2 Charts</option>
        <option value="3">3 Charts</option>
        <option value="6">6 Charts</option>
      </select>

      {/* ================= THEME & PRESET ================= */}
      <div style={{ marginLeft: "auto", display: "flex", gap: "4px", alignItems: "center" }}>
        {/* Mode Toggle */}
        <div style={{ display: "flex", gap: "2px", borderRadius: "8px", background: "rgba(255, 255, 255, 0.04)", padding: "2px" }}>
          <button
            onClick={() => setMode("dark")}
            className={`ui-button ${mode === "dark" ? "ui-button--active" : ""}`}
            style={{ height: "26px", padding: "0 8px" }}
            title="Dark Mode"
          >
            🌙
          </button>
          <button
            onClick={() => setMode("light")}
            className={`ui-button ${mode === "light" ? "ui-button--active" : ""}`}
            style={{ height: "26px", padding: "0 8px" }}
            title="Light Mode"
          >
            ☀️
          </button>
        </div>

        {/* Theme Preset Selector */}
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as "professional" | "premium" | "vibrant" | "monochrome" | "gold" | "ict")}
          className="ui-dropdown"
          title="Select theme"
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