export default function TopBar({ layoutType, setLayoutType }: any) {
  return (
    <div className="top-bar">
      {/* Layout Selector */}
      <select
        value={layoutType}
        onChange={(e) => setLayoutType(e.target.value)}
      >
        <option value="2">2 Charts</option>
        <option value="4">4 Charts</option>
        <option value="6">6 Charts</option>
      </select>

      {/* Future: symbols / timeframe */}
      <div style={{ marginLeft: "auto", color: "#666", fontSize: "12px", whiteSpace: "nowrap" }}>
        Trading Platform
      </div>
    </div>
  );
}