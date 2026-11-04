import { contextBridge, ipcRenderer } from "electron";
import type { DiaryPayload, DisplayInfo } from "../shared/types";

export type DiaryResult =
  | { ok: true; data: DiaryPayload }
  | { ok: false; error: string };

const api = {
  setIgnore(ignore: boolean) {
    ipcRenderer.send("pet:set-ignore", ignore);
  },
  focus(): void {
    ipcRenderer.send("pet:focus");
  },
  openDiary(): void {
    ipcRenderer.send("diary:open");
  },
  closeDiary(): void {
    ipcRenderer.send("diary:close");
  },
  resizeDiary(size: { width: number; height: number }): void {
    ipcRenderer.send("diary:resize", size);
  },
  loadDiary(book?: string | null): Promise<DiaryResult> {
    return ipcRenderer.invoke("diary:load", book ?? null) as Promise<DiaryResult>;
  },
  diaryAvailability(): Promise<boolean> {
    return ipcRenderer.invoke("diary:availability") as Promise<boolean>;
  },
  getAutoLaunch(): Promise<boolean> {
    return ipcRenderer.invoke("app:get-auto-launch") as Promise<boolean>;
  },
  setAutoLaunch(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke("app:set-auto-launch", enabled) as Promise<boolean>;
  },
  listDisplays(): Promise<DisplayInfo[]> {
    return ipcRenderer.invoke("pet:list-displays") as Promise<DisplayInfo[]>;
  },
  setDisplay(displayId: string): Promise<DisplayInfo | null> {
    return ipcRenderer.invoke("pet:set-display", displayId) as Promise<DisplayInfo | null>;
  },
  onDisplayChanged(handler: (info: DisplayInfo) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, info: DisplayInfo) => handler(info);
    ipcRenderer.on("pet:display-changed", listener);
    return () => {
      ipcRenderer.removeListener("pet:display-changed", listener);
    };
  },
  openConfig(): void {
    ipcRenderer.send("app:open-config");
  },
  quit(): void {
    ipcRenderer.send("app:quit");
  },
};

contextBridge.exposeInMainWorld("petApi", api);

export type PetApi = typeof api;
