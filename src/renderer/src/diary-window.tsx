import { DiaryPanel } from "./components/live2d/diary-panel";

export function DiaryWindow() {
  return (
    <DiaryPanel
      windowMode
      onClose={() => window.petApi.closeDiary()}
      onSizeChange={(size) => window.petApi.resizeDiary(size)}
    />
  );
}
