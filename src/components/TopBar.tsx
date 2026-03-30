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
  isPlaying?: boolean;
  setIsPlaying?: (isPlaying: boolean) => void;
  playSpeed?: 0.5 | 1 | 2 | 5;
  setPlaySpeed?: (speed: 0.5 | 1 | 2 | 5) => void;
  isReplaySync?: boolean;
  setIsReplaySync?: (isReplaySync: boolean) => void;
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
  isPlaying = false,
  setIsPlaying,
  playSpeed = 1,
  setPlaySpeed,
  isReplaySync = false,
  setIsReplaySync,
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

              {/* Play / Pause */}
              <button
                onClick={() => setIsPlaying?.(!isPlaying)}
                className={`ui-button ${isPlaying ? "ui-button--active" : ""}`}
                style={{ height: "28px", padding: "0 10px", fontSize: "14px" }}
                title={isPlaying ? "Pause autoplay" : "Start autoplay"}
              >
                {isPlaying ? "⏸" : "▶️"}
              </button>

              {/* Speed Control */}
              {isPlaying && (
                <select
                  value={playSpeed}
                  onChange={(e) => setPlaySpeed?.(parseFloat(e.target.value) as 0.5 | 1 | 2 | 5)}
                  className="ui-dropdown"
                  style={{ height: "28px", fontSize: "12px" }}
                  title="Playback speed"
                >
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={2}>2x</option>
                  <option value={5}>5x</option>
                </select>
              )}

              {/* Multi-Chart Sync Toggle */}
              <button
                onClick={() => setIsReplaySync?.(!isReplaySync)}
                className={`ui-button ${isReplaySync ? "ui-button--active" : ""}`}
                style={{ height: "28px", padding: "0 10px", fontSize: "14px" }}
                title={isReplaySync ? "All charts synced to replay" : "Chart sync OFF - only active chart replays"}
              >
                {isReplaySync ? "🔗" : "🔓"}
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