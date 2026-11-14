import { createRoot } from "react-dom/client";
import App from "./app";
import { ChatWindow } from "./chat-window";
import { DiaryWindow } from "./diary-window";
import "./styles/global.css";
import "./styles/appearance.css";
import "./styles/pet-theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const view = new URLSearchParams(window.location.search).get("view");

createRoot(root).render(
  view === "diary" ? <DiaryWindow /> : view === "chat" ? <ChatWindow /> : <App />,
);
