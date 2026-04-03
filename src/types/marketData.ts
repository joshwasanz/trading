export type Timeframe = "15s" | "1m" | "3m";

export type Candle = {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type SupportedSymbol = {
  id: string;
  label: string;
};

export type ProviderMode = "synthetic" | "twelve_data" | "snapshot_replay";

export type ProviderCapabilities = {
  providerMode: ProviderMode;
  supportedSymbols: SupportedSymbol[];
  supportedTimeframes: Timeframe[];
  liveSupported: boolean;
  notice: string | null;
  validationMode?: boolean;
  strictRealtime?: boolean;
  liveSource?: string | null;
  pollIntervalMs?: number | null;
};

export type HistoricalRequest = {
  symbol: string;
  timeframe: Timeframe;
  from?: number;
  to?: number;
  limit?: number;
};

export type HistoryUiStatus = "idle" | "loading" | "empty" | "failed";

export type HistoryUiSource = "initial" | "replay" | "jump" | "context-sync";

export type HistoryUiState = {
  status: HistoryUiStatus;
  message: string | null;
  source?: HistoryUiSource;
};
