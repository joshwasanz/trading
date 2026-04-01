import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

function relayStartupDebugLog(stage: string, payload: Record<string, unknown> = {}) {
  void invoke("frontend_debug_log", {
    scope: "startup",
    payload: JSON.stringify({
      stage,
      mode: "minimal",
      ...payload,
    }),
  }).catch(() => undefined);
}

export default function StartupDiagnosticsApp() {
  useEffect(() => {
    relayStartupDebugLog("diagnostics:mounted", {
      href: window.location.href,
      userAgent: navigator.userAgent,
    });
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at top, rgba(59,130,246,0.2), transparent 40%), #0f172a",
        color: "#e2e8f0",
        fontFamily: "Segoe UI, sans-serif",
        padding: "2rem",
      }}
    >
      <section
        style={{
          width: "min(42rem, 100%)",
          border: "1px solid rgba(148, 163, 184, 0.3)",
          borderRadius: "1rem",
          background: "rgba(15, 23, 42, 0.82)",
          boxShadow: "0 24px 80px rgba(15, 23, 42, 0.35)",
          padding: "2rem",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: "0.875rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#93c5fd",
          }}
        >
          Startup Diagnostics
        </p>
        <h1 style={{ margin: "0.75rem 0 1rem", fontSize: "2rem", lineHeight: 1.15 }}>
          Minimal renderer mode is running
        </h1>
        <p style={{ margin: 0, lineHeight: 1.7, color: "#cbd5e1" }}>
          This view intentionally skips provider initialization, workspace restore, chart mounting,
          and live subscriptions. If this screen stays open, the crash is in the normal app startup
          path rather than the bare Tauri window bootstrap.
        </p>
      </section>
    </main>
  );
}
