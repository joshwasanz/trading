export type ReplayTimeframe = "15s" | "1m" | "3m";

export type ReplayStartPayload = {
  panelId: string;
  symbol: string;
  timeframe: ReplayTimeframe;
  timestamp: number;
};
