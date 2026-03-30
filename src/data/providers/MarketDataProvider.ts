import type {
  Candle,
  HistoricalRequest,
  SupportedSymbol,
  Timeframe,
} from "../../types/marketData";

export type LiveSubscription = {
  unsubscribe: () => Promise<void> | void;
};

export interface MarketDataProvider {
  getSupportedSymbols(): Promise<SupportedSymbol[]>;
  getHistorical(request: HistoricalRequest): Promise<Candle[]>;
  subscribeLive(
    symbol: string,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void
  ): Promise<LiveSubscription>;
}
