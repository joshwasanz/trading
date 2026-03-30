import { useThemeStore } from "../store/useThemeStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { useLayoutState } from "../store/useLayoutState";
import type { Workspace } from "../types/workspace";

type Props = {
  layoutType: string;
  setLayoutType: (layoutType: string) => void;
  isReplay?: boolean;
  setIsReplay?: (isReplay: boolean) => void;
  replayIndex?: number;
  stepForward?: () => void;
  stepBackward?: () => void;
  resetReplay?: () => void;
};

export default function TopBar({
  layoutType,
  setLayoutType,
  isReplay = false,
  setIsReplay,
  replayIndex = 0,
  stepForward,
  stepBackward,
  resetReplay,
}: Props) {
  const { mode, setMode, preset, setPreset } = useThemeStore();
  const { workspaces, activeWorkspaceId, setActiveWorkspace, saveWorkspace } = useWorkspaceStore();
  const { panels, drawingsBySymbol } = useLayoutState();

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

      {/* ================= WORKSPACE ================= */}
      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
        {/* Save Workspace */}
        <button
          className="ui-button"
          onClick={() => {
            const name = prompt("Workspace name:", "My Workspace");
            if (!name) return;

            const ws: Workspace = {
              id: crypto.randomUUID(),
              name,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              layoutType,
              panels,
              drawingsBySymbol,
              theme: { mode, preset },
            };

            saveWorkspace(ws);
            setActiveWorkspace(ws.id);
          }}
          title="Save current layout and drawings"
        >
          💾 Save
        </button>

        {/* Load Workspace */}
        <select
          value={activeWorkspaceId || ""}
          onChange={(e) => {
            if (e.target.value) {
              setActiveWorkspace(e.target.value);
            }
          }}
          className="ui-dropdown"
          title="Load a saved workspace"
        >
          <option value="">Load workspace...</option>
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>

        {/* Delete Workspace */}
        {activeWorkspaceId && (
          <button
            className="ui-button ui-button--danger"
            onClick={() => {
              const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
              if (!workspace || !window.confirm(`Delete "${workspace.name}"?`)) return;

              useWorkspaceStore.getState().deleteWorkspace(activeWorkspaceId);
              setActiveWorkspace("");
            }}
            title="Delete current workspace"
          >
            🗑 Delete
          </button>
        )}
      </div>

      {/* ================= REPLAY ENGINE ================= */}
      {isReplay !== undefined && (
        <div style={{ display: "flex", gap: "4px", alignItems: "center", marginLeft: "12px" }}>
          <button
            onClick={() => setIsReplay?.(!isReplay)}
            className={`ui-button ${isReplay ? "ui-button--active" : ""}`}
            style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
            title={isReplay ? "Exit Replay Mode" : "Enter Replay Mode"}
          >
            {isReplay ? "Stop" : "Replay"}
          </button>

          {isReplay && (
            <>
              <button
                onClick={() => stepBackward?.()}
                className="ui-button"
                style={{ height: "28px", padding: "0 8px", fontSize: "14px" }}
                title="Previous candle"
              >
                ◀
              </button>

              <button
                onClick={() => stepForward?.()}
                className="ui-button"
                style={{ height: "28px", padding: "0 8px", fontSize: "14px" }}
                title="Next candle"
              >
                ▶
              </button>

              <button
                onClick={() => resetReplay?.()}
                className="ui-button"
                style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
                title="Reset to start"
              >
                Reset
              </button>

              <span style={{ fontSize: "12px", color: "var(--panel-muted)", marginLeft: "4px" }}>
                Index: {replayIndex}
              </span>
            </>
          )}
        </div>
      )}

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