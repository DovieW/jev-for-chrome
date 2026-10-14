export type VoiceStatus =
  | "initializing"
  | "permission"
  | "recording"
  | "transcribing"
  | "starting"
  | "error"
  | "closed";
export interface VoiceState {
  status: VoiceStatus;
  elapsedMs?: number;
  waveform?: number[];
  text?: string;
  error?: string;
  retryable?: boolean;
}
export type VoiceAction =
  "send" | "cancel" | "retry" | "permission" | "settings";
