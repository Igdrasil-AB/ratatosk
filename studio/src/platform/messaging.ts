import type { DraftRecipe } from "../../../src/core/recorder/types";

export type StudioMessage =
  | { type: "recorderStart" }
  | { type: "recorderStop" }
  | { type: "recorderStatus" }
  | { type: "recorderProgress" };

export interface RecorderProgress {
  recording: boolean;
  captured: number;
  documents: number;
  detected: boolean;
}

export interface RecorderStopResult {
  draft: DraftRecipe | null;
  captured: number;
  samples: string[];
  docLinks: string[];
  report: string;
}

export type StudioResponse =
  | { ok: true }
  | { ok: true; recording: boolean }
  | { ok: true; progress: RecorderProgress }
  | ({ ok: true } & RecorderStopResult)
  | { ok: false; error: string };

export function send(message: StudioMessage): Promise<StudioResponse> {
  return chrome.runtime.sendMessage(message) as Promise<StudioResponse>;
}
