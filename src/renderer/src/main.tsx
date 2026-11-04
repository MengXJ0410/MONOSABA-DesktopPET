import { createRoot } from "react-dom/client";
import App from "./app";
import { DiaryWindow } from "./diary-window";
import "./styles/global.css";
import "./styles/appearance.css";
import "./styles/pet-theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const isDiaryWindow =
  new URLSearchParams(window.location.search).get("view") === "diary";

createRoot(root).render(isDiaryWindow ? <DiaryWindow /> : <App />);
