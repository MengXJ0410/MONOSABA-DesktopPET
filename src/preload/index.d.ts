import type { DiaryPayload, DisplayInfo } from "../shared/types";

export type DiaryResult =
  | { ok: true; data: DiaryPayload }
  | { ok: false; error: string };

export type PetApi = {
  setIgnore(ignore: boolean): void;
  focus(): void;
  openDiary(): void;
  closeDiary(): void;
  resizeDiary(size: { width: number; height: number }): void;
  loadDiary(book?: string | null): Promise<DiaryResult>;
  diaryAvailability(): Promise<boolean>;
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<boolean>;
  listDisplays(): Promise<DisplayInfo[]>;
  setDisplay(displayId: string): Promise<DisplayInfo | null>;
  onDisplayChanged(handler: (info: DisplayInfo) => void): () => void;
  openConfig(): void;
  quit(): void;
};

declare global {
  interface Window {
    petApi: PetApi;
  }
}

export {};
