export type Timeframe = "15s" | "1m" | "3m";

export type Candle = {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type SupportedSymbol = {
  id: string;
  label: string;
};

export type HistoricalRequest = {
  symbol: string;
  timeframe: Timeframe;
  from?: number;
  to?: number;
  limit?: number;
};
