import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Candle,
  HistoricalRequest,
  SupportedSymbol,
  Timeframe,
} from "../../types/marketData";
import type { LiveSubscription, MarketDataProvider } from "./MarketDataProvider";

type StreamEventPayload = Candle & {
  timeframe: Timeframe;
};

export class TauriMarketDataProvider implements MarketDataProvider {
  async getSupportedSymbols(): Promise<SupportedSymbol[]> {
    return invoke<SupportedSymbol[]>("get_supported_symbols");
  }

  async getHistorical(request: HistoricalRequest): Promise<Candle[]> {
    return invoke<Candle[]>("get_historical", {
      symbol: request.symbol,
      timeframe: request.timeframe,
      from: request.from ?? null,
      to: request.to ?? null,
      limit: request.limit ?? null,
    });
  }

  async subscribeLive(
    symbol: string,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void
  ): Promise<LiveSubscription> {
    const eventName = `candle://${symbol}/${timeframe}`;

    const unlisten: UnlistenFn = await listen<StreamEventPayload>(eventName, (event) => {
      const payload = event.payload;

      if (payload.symbol !== symbol || payload.timeframe !== timeframe) {
        return;
      }

      onCandle({
        symbol: payload.symbol,
        time: payload.time,
        open: payload.open,
        high: payload.high,
        low: payload.low,
        close: payload.close,
      });
    });

    await invoke("subscribe_live", { symbol, timeframe });

    return {
      unsubscribe: async () => {
        unlisten();
        await invoke("unsubscribe_live", { symbol, timeframe });
      },
    };
  }
}
