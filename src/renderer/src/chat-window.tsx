import { Component, type ErrorInfo, type ReactNode } from "react";
import { ChatPanel } from "./components/chat/chat-panel";

type BoundaryState = { error: Error | null };

/** 渲染期未捕获异常时 React 会卸载整棵树，窗口会变成空白；这里兜一层可重载的提示。 */
class ChatErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[chat] render error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 12,
        }}
      >
        <div
          style={{
            maxWidth: 420,
            padding: "18px 20px",
            borderRadius: 12,
            border: "1px solid rgba(200, 16, 46, 0.55)",
            background: "rgba(14, 5, 9, 0.95)",
            color: "#ffeef1",
            textAlign: "center",
          }}
        >
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>聊天界面出了点问题。</p>
          <pre
            style={{
              margin: "0 0 12px",
              maxHeight: 120,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              fontSize: 11,
              opacity: 0.6,
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid rgba(200, 16, 46, 0.6)",
              background: "rgba(200, 16, 46, 0.25)",
              color: "#ffeef1",
              cursor: "pointer",
            }}
          >
            重新载入
          </button>
        </div>
      </div>
    );
  }
}

export function ChatWindow() {
  return (
    <ChatErrorBoundary>
      <ChatPanel />
    </ChatErrorBoundary>
  );
}
