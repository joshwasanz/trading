import type { ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type RootComponentModule = {
  default: ComponentType;
};

const STARTUP_DIAGNOSTICS_MODE =
  import.meta.env.VITE_STARTUP_DIAGNOSTICS_MODE === "minimal" ? "minimal" : "full";

function relayStartupDebugLog(stage: string, payload: Record<string, unknown> = {}) {
  void invoke("frontend_debug_log", {
    scope: "startup",
    payload: JSON.stringify({
      stage,
      mode: STARTUP_DIAGNOSTICS_MODE,
      ...payload,
    }),
  }).catch(() => undefined);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function loadRootComponent(): Promise<ComponentType> {
  relayStartupDebugLog("component:loading");

  const module: RootComponentModule =
    STARTUP_DIAGNOSTICS_MODE === "minimal"
      ? await import("./StartupDiagnosticsApp")
      : await import("./App");

  relayStartupDebugLog("component:loaded");
  return module.default;
}

function StartupBootstrapFailure({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#111827",
        color: "#f9fafb",
        fontFamily: "Segoe UI, sans-serif",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: "40rem", textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: "0.875rem", letterSpacing: "0.08em", opacity: 0.7 }}>
          STARTUP DIAGNOSTICS
        </p>
        <h1 style={{ margin: "0.75rem 0", fontSize: "2rem" }}>Renderer bootstrap failed</h1>
        <p style={{ margin: 0, lineHeight: 1.6, opacity: 0.9 }}>{message}</p>
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found");
}

const root = ReactDOM.createRoot(rootElement);
relayStartupDebugLog("bootstrap:start");

void loadRootComponent()
  .then((Component) => {
    relayStartupDebugLog("render:start");
    root.render(<Component />);
  })
  .catch((error) => {
    const message = stringifyError(error);
    console.error("[startup] renderer bootstrap failed", error);
    relayStartupDebugLog("render:error", { message });
    root.render(<StartupBootstrapFailure message={message} />);
  });
