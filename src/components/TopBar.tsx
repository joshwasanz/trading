import { useThemeStore } from "../store/useThemeStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { useLayoutState } from "../store/useLayoutState";
import { FREE_TIER_VALIDATION_MODE } from "../instruments";
import type { SessionKey } from "../utils/sessions";
import type { Workspace } from "../types/workspace";
import { formatReplayTime } from "../utils/replayDisplay";

type Props = {
  layoutType: string;
  setLayoutType: (layoutType: string) => void;
  isReplay?: boolean;
  setIsReplay?: (isReplay: boolean) => void;
  isReplaySelectingStart?: boolean;
  armReplaySelection?: () => void;
  replayStartTime?: number | null;
  replayCursorTime?: number | null;
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
  jumpTime?: string;
  setJumpTime?: (time: string) => void;
  goToTime?: (targetTime: number) => void;
  replayHistoryStatus?: "idle" | "loading" | "failed";
  replayHistoryMessage?: string | null;
  providerNotice?: {
    tone: "warning" | "error";
    message: string;
  } | null;
  showSessions?: boolean;
  setShowSessions?: (showSessions: boolean) => void;
  showSessionLevels?: boolean;
  setShowSessionLevels?: (showSessionLevels: boolean) => void;
  showSessionRanges?: boolean;
  setShowSessionRanges?: (showSessionRanges: boolean) => void;
  showSma?: boolean;
  setShowSma?: (showSma: boolean) => void;
  smaPeriod?: number;
  setSmaPeriod?: (period: number) => void;
  jumpToSession?: (session: SessionKey) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
};

export default function TopBar({
  layoutType,
  setLayoutType,
  isReplay = false,
  setIsReplay,
  isReplaySelectingStart = false,
  armReplaySelection,
  replayStartTime = null,
  replayCursorTime = null,
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
  jumpTime = "",
  setJumpTime,
  goToTime,
  replayHistoryStatus = "idle",
  replayHistoryMessage = null,
  providerNotice = null,
  showSessions = true,
  setShowSessions,
  showSessionLevels = true,
  setShowSessionLevels,
  showSessionRanges = true,
  setShowSessionRanges,
  showSma = false,
  setShowSma,
  smaPeriod = 20,
  setSmaPeriod,
  jumpToSession,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: Props) {
  const { mode, setMode, preset, setPreset } = useThemeStore();
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    saveWorkspace,
    updateWorkspace,
    deleteWorkspace,
  } = useWorkspaceStore();
  const { panels, drawingsBySymbol } = useLayoutState();
  const replayReady = !isReplaySelectingStart && replayCursorTime !== null;
  const replayStartLabel = formatReplayTime(replayStartTime);
  const replayTimeLabel = replayReady
    ? formatReplayTime(replayCursorTime)
    : "Pick a candle to start";
  const replayHistoryTone =
    replayHistoryStatus === "failed"
      ? {
          background: "rgba(220, 38, 38, 0.12)",
          border: "1px solid rgba(220, 38, 38, 0.28)",
          color: "#ef4444",
        }
      : {
          background: "rgba(59, 130, 246, 0.10)",
          border: "1px solid rgba(59, 130, 246, 0.24)",
          color: "var(--panel-text)",
        };
  const providerNoticeTone =
    providerNotice?.tone === "error"
      ? {
          background: "rgba(220, 38, 38, 0.12)",
          border: "1px solid rgba(220, 38, 38, 0.28)",
          color: "#ef4444",
        }
      : {
          background: "rgba(245, 158, 11, 0.10)",
          border: "1px solid rgba(245, 158, 11, 0.24)",
          color: "var(--panel-text)",
        };

  return (
    <div className="top-bar">

      {/* ================= LAYOUT ================= */}
      <select
        value={layoutType}
        onChange={(e) => setLayoutType(e.target.value)}
        className="ui-dropdown"
        title="Select layout"
      >
        {FREE_TIER_VALIDATION_MODE ? (
          <option value="1">1 Chart</option>
        ) : (
          <>
            <option value="2">2 Charts</option>
            <option value="3">3 Charts</option>
            <option value="6">6 Charts</option>
          </>
        )}
      </select>

      {/* ================= WORKSPACE ================= */}
      {!FREE_TIER_VALIDATION_MODE && (
        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
        {/* Save Workspace */}
        <button
          className="ui-button"
          onClick={() => {
            if (activeWorkspaceId) {
              updateWorkspace(activeWorkspaceId, {
                layoutType,
                panels,
                drawingsBySymbol,
              });
              return;
            }

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
            };

            saveWorkspace(ws);
          }}
          title="Save current layout and drawings"
        >
          💾 Save
        </button>

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
            };

            saveWorkspace(ws);
          }}
          title="Save current layout as a new workspace"
        >
          Save As
        </button>

        {/* Load Workspace */}
        <select
          value={activeWorkspaceId || ""}
          onChange={(e) => setActiveWorkspace(e.target.value || null)}
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

              deleteWorkspace(activeWorkspaceId);
            }}
            title="Delete current workspace"
          >
            🗑 Delete
          </button>
        )}
        </div>
      )}

      <div style={{ display: "flex", gap: "4px", alignItems: "center", marginLeft: "12px" }}>
        <button
          onClick={() => onUndo?.()}
          disabled={!canUndo}
          className="ui-button"
          style={{
            height: "28px",
            padding: "0 10px",
            fontSize: "12px",
            opacity: canUndo ? 1 : 0.5,
            cursor: canUndo ? "pointer" : "not-allowed",
          }}
          title="Undo (Ctrl/Cmd+Z)"
        >
          Undo
        </button>

        <button
          onClick={() => onRedo?.()}
          disabled={!canRedo}
          className="ui-button"
          style={{
            height: "28px",
            padding: "0 10px",
            fontSize: "12px",
            opacity: canRedo ? 1 : 0.5,
            cursor: canRedo ? "pointer" : "not-allowed",
          }}
          title="Redo (Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y)"
        >
          Redo
        </button>
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
                onClick={() => armReplaySelection?.()}
                className={`ui-button ${isReplaySelectingStart ? "ui-button--active" : ""}`}
                style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
                title="Choose a replay start candle from the chart"
              >
                {isReplaySelectingStart ? "Pick Candle" : "Pick Start"}
              </button>

              <button
                onClick={() => stepBackward?.()}
                className="ui-button"
                disabled={!replayReady}
                style={{
                  height: "28px",
                  padding: "0 8px",
                  fontSize: "14px",
                  opacity: replayReady ? 1 : 0.5,
                  cursor: replayReady ? "pointer" : "not-allowed",
                }}
                title="Previous candle"
              >
                ◀
              </button>

              <button
                onClick={() => stepForward?.()}
                className="ui-button"
                disabled={!replayReady}
                style={{
                  height: "28px",
                  padding: "0 8px",
                  fontSize: "14px",
                  opacity: replayReady ? 1 : 0.5,
                  cursor: replayReady ? "pointer" : "not-allowed",
                }}
                title="Next candle"
              >
                ▶
              </button>

              <button
                onClick={() => resetReplay?.()}
                className="ui-button"
                disabled={!replayReady}
                style={{
                  height: "28px",
                  padding: "0 12px",
                  fontSize: "12px",
                  opacity: replayReady ? 1 : 0.5,
                  cursor: replayReady ? "pointer" : "not-allowed",
                }}
                title="Reset to start"
              >
                Reset
              </button>

              {/* Play / Pause */}
              <button
                onClick={() => setIsPlaying?.(!isPlaying)}
                className={`ui-button ${isPlaying ? "ui-button--active" : ""}`}
                disabled={!replayReady}
                style={{
                  height: "28px",
                  padding: "0 10px",
                  fontSize: "14px",
                  opacity: replayReady ? 1 : 0.5,
                  cursor: replayReady ? "pointer" : "not-allowed",
                }}
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
                  disabled={!replayReady}
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

              {/* Jump to Time */}
              <input
                type="datetime-local"
                value={jumpTime}
                onChange={(e) => setJumpTime?.(e.target.value)}
                className="ui-input"
                style={{ height: "28px", fontSize: "11px", padding: "0 8px", width: "180px" }}
                title="Jump to specific time"
              />

              <button
                onClick={() => {
                  if (!jumpTime) return;
                  const ts = Math.floor(new Date(jumpTime).getTime() / 1000);
                  goToTime?.(ts);
                }}
                className="ui-button"
                style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
                title="Jump to selected time"
              >
                GO
              </button>

              <span style={{ fontSize: "12px", color: "var(--panel-muted)", marginLeft: "4px" }}>
                Index: {replayIndex}
              </span>

              <span style={{ fontSize: "12px", color: "var(--panel-muted)" }}>
                {isReplaySelectingStart
                  ? isReplaySync
                    ? "Click a candle on any chart"
                    : "Click a candle on the active chart"
                  : `Start: ${replayStartLabel}`}
              </span>

              <span style={{ fontSize: "12px", color: "var(--panel-muted)" }}>
                {isReplaySelectingStart ? "Select start candle..." : `Current: ${replayTimeLabel}`}
              </span>

              {replayHistoryStatus !== "idle" && replayHistoryMessage && (
                <span
                  style={{
                    ...replayHistoryTone,
                    fontSize: "11px",
                    padding: "4px 8px",
                    borderRadius: "999px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {replayHistoryMessage}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {providerNotice && (
        <div style={{ display: "flex", alignItems: "center", marginLeft: "12px" }}>
          <span
            style={{
              ...providerNoticeTone,
              fontSize: "11px",
              padding: "4px 8px",
              borderRadius: "999px",
              whiteSpace: "nowrap",
            }}
            title={providerNotice.message}
          >
            {providerNotice.message}
          </span>
        </div>
      )}

      {(setShowSessions ||
        setShowSessionLevels ||
        setShowSessionRanges ||
        setShowSma ||
        jumpToSession) && (
        <div style={{ display: "flex", gap: "4px", alignItems: "center", marginLeft: "12px" }}>
          <button
            onClick={() => setShowSessions?.(!showSessions)}
            className={`ui-button ${showSessions ? "ui-button--active" : ""}`}
            style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
            title={showSessions ? "Hide session overlays" : "Show session overlays"}
          >
            Sessions {showSessions ? "ON" : "OFF"}
          </button>

          <button
            onClick={() => setShowSessionLevels?.(!showSessionLevels)}
            className={`ui-button ${showSessionLevels ? "ui-button--active" : ""}`}
            style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
            title={showSessionLevels ? "Hide session highs and lows" : "Show session highs and lows"}
          >
            Session H/L {showSessionLevels ? "ON" : "OFF"}
          </button>

          <button
            onClick={() => setShowSessionRanges?.(!showSessionRanges)}
            className={`ui-button ${showSessionRanges ? "ui-button--active" : ""}`}
            style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
            title={showSessionRanges ? "Hide session range boxes" : "Show session range boxes"}
          >
            Session Range {showSessionRanges ? "ON" : "OFF"}
          </button>

          <button
            onClick={() => setShowSma?.(!showSma)}
            className={`ui-button ${showSma ? "ui-button--active" : ""}`}
            style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
            title={showSma ? "Hide SMA overlay" : "Show SMA overlay"}
          >
            SMA {showSma ? "ON" : "OFF"}
          </button>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              height: "28px",
              padding: "0 10px",
              borderRadius: "8px",
              border: "1px solid var(--panel-border)",
              background: "var(--panel-bg-secondary)",
              color: "var(--panel-text)",
              fontSize: "12px",
            }}
            title="SMA period"
          >
            SMA P
            <input
              type="number"
              min={2}
              max={200}
              step={1}
              value={smaPeriod}
              onChange={(event) => {
                const nextValue = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(nextValue)) {
                  setSmaPeriod?.(nextValue);
                }
              }}
              style={{
                width: "52px",
                height: "20px",
                borderRadius: "6px",
                border: "1px solid var(--panel-border)",
                background: "var(--panel-bg)",
                color: "var(--panel-text)",
                padding: "0 6px",
                fontSize: "12px",
              }}
            />
          </label>

          {showSessions && (
            <>
              <button
                onClick={() => jumpToSession?.("asia")}
                className="ui-button"
                style={{ height: "28px", padding: "0 10px", fontSize: "12px" }}
                title="Jump to Asia session start"
              >
                Asia
              </button>

              <button
                onClick={() => jumpToSession?.("london")}
                className="ui-button"
                style={{ height: "28px", padding: "0 10px", fontSize: "12px" }}
                title="Jump to London session start"
              >
                London
              </button>

              <button
                onClick={() => jumpToSession?.("newyork")}
                className="ui-button"
                style={{ height: "28px", padding: "0 10px", fontSize: "12px" }}
                title="Jump to New York session start"
              >
                New York
              </button>
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
