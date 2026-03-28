import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Caught crash:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#0e0e11",
            color: "#ef5350",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "monospace",
            padding: "32px",
            gap: "16px",
          }}
        >
          <div style={{ fontSize: "18px", fontWeight: 700 }}>
            ⚠ App crashed — check the DevTools console for details
          </div>
          <div
            style={{
              fontSize: "13px",
              color: "#c9ced6",
              background: "#1a1a1f",
              border: "1px solid #2a2d34",
              borderRadius: "6px",
              padding: "16px 24px",
              maxWidth: "700px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: "8px",
              padding: "8px 24px",
              background: "#4da3ff",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Try to recover
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
