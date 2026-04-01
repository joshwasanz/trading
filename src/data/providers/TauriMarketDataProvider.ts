import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Candle,
  HistoricalRequest,
  ProviderCapabilities,
  SupportedSymbol,
  Timeframe,
} from "../../types/marketData";
import { sanitizeCandleSeries } from "../../utils/candleCache";
import type { LiveSubscription, MarketDataProvider } from "./MarketDataProvider";

type StreamEventPayload = Candle & {
  timeframe: Timeframe;
};

type SharedLiveSubscription = {
  symbol: string;
  timeframe: Timeframe;
  unlisten: UnlistenFn;
  consumers: Map<number, (candle: Candle) => void>;
};

const HISTORICAL_CACHE_LIMIT = 48;
const SUPPORTED_TIMEFRAMES: Timeframe[] = ["15s", "1m", "3m"];
const DEBUG_LIVE_UPDATES = import.meta.env.DEV;

function relayFrontendDebugLog(scope: string, payload: unknown) {
  if (!DEBUG_LIVE_UPDATES) {
    return;
  }

  void invoke("frontend_debug_log", {
    scope,
    payload: JSON.stringify(payload),
  }).catch(() => undefined);
}

function createProviderError(scope: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[MarketDataProvider] ${scope}: ${message}`);
}

function normalizeSupportedSymbols(symbols: SupportedSymbol[]): SupportedSymbol[] {
  const seen = new Set<string>();
  const normalized: SupportedSymbol[] = [];

  for (const symbol of symbols) {
    const id = typeof symbol?.id === "string" ? symbol.id.trim().toLowerCase() : "";
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push({
      id,
      label:
        typeof symbol?.label === "string" && symbol.label.trim().length > 0
          ? symbol.label.trim()
          : id.toUpperCase(),
    });
  }

  return normalized;
}

function normalizeSupportedTimeframes(timeframes: Timeframe[] | null | undefined): Timeframe[] {
  const seen = new Set<Timeframe>();
  const normalized: Timeframe[] = [];

  for (const timeframe of timeframes ?? []) {
    if (!SUPPORTED_TIMEFRAMES.includes(timeframe) || seen.has(timeframe)) {
      continue;
    }

    seen.add(timeframe);
    normalized.push(timeframe);
  }

  return normalized.length > 0 ? normalized : [...SUPPORTED_TIMEFRAMES];
}

function normalizeCapabilities(raw: ProviderCapabilities): ProviderCapabilities {
  const supportedSymbols = normalizeSupportedSymbols(raw?.supportedSymbols ?? []);

  return {
    providerMode: raw?.providerMode === "twelve_data" ? "twelve_data" : "synthetic",
    supportedSymbols,
    supportedTimeframes: normalizeSupportedTimeframes(raw?.supportedTimeframes),
    liveSupported: Boolean(raw?.liveSupported),
    notice:
      typeof raw?.notice === "string" && raw.notice.trim().length > 0 ? raw.notice.trim() : null,
    validationMode: Boolean(raw?.validationMode),
    strictRealtime: Boolean(raw?.strictRealtime),
    liveSource:
      typeof raw?.liveSource === "string" && raw.liveSource.trim().length > 0
        ? raw.liveSource.trim()
        : null,
    pollIntervalMs:
      typeof raw?.pollIntervalMs === "number" && Number.isFinite(raw.pollIntervalMs)
        ? raw.pollIntervalMs
        : null,
  };
}

export class TauriMarketDataProvider implements MarketDataProvider {
  private capabilitiesCache: ProviderCapabilities | null = null;
  private supportedSymbolsCache: SupportedSymbol[] | null = null;
  private historicalCache = new Map<string, Candle[]>();
  private sharedSubscriptions = new Map<string, SharedLiveSubscription>();
  private nextConsumerId = 1;

  private getProviderScope(): string {
    return this.capabilitiesCache?.providerMode ?? "unknown";
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    if (this.capabilitiesCache) {
      return {
        ...this.capabilitiesCache,
        supportedSymbols: this.cloneSupportedSymbols(this.capabilitiesCache.supportedSymbols),
        supportedTimeframes: [...this.capabilitiesCache.supportedTimeframes],
      };
    }

    try {
      const raw = await invoke<ProviderCapabilities>("get_provider_capabilities");
      const normalized = normalizeCapabilities(raw);

      this.capabilitiesCache = normalized;
      this.supportedSymbolsCache = normalized.supportedSymbols;

      return {
        ...normalized,
        supportedSymbols: this.cloneSupportedSymbols(normalized.supportedSymbols),
        supportedTimeframes: [...normalized.supportedTimeframes],
      };
    } catch (error) {
      throw createProviderError("getCapabilities failed", error);
    }
  }

  private async loadSupportedSymbols(): Promise<SupportedSymbol[]> {
    const rawSymbols = await invoke<SupportedSymbol[]>("get_supported_symbols");
    const normalized = normalizeSupportedSymbols(rawSymbols);

    if (normalized.length === 0) {
      throw new Error("[MarketDataProvider] getSupportedSymbols: no supported symbols returned");
    }

    this.supportedSymbolsCache = normalized;
    return normalized;
  }

  private async getKnownSymbolIds(): Promise<Set<string> | null> {
    if (this.supportedSymbolsCache) {
      return new Set(this.supportedSymbolsCache.map((symbol) => symbol.id));
    }

    try {
      const symbols = await this.loadSupportedSymbols();
      return new Set(symbols.map((symbol) => symbol.id));
    } catch {
      return null;
    }
  }

  private async assertSupportedSymbol(symbol: string): Promise<string> {
    const normalizedSymbol = symbol.trim().toLowerCase();
    const symbolIds = await this.getKnownSymbolIds();

    if (symbolIds && symbolIds.size > 0 && !symbolIds.has(normalizedSymbol)) {
      throw new Error(`Unsupported symbol: ${normalizedSymbol}`);
    }

    return normalizedSymbol;
  }

  private assertSupportedTimeframe(timeframe: Timeframe): void {
    if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }
  }

  private sanitizeHistoricalResult(
    symbol: string,
    timeframe: Timeframe,
    candles: unknown
  ): Candle[] {
    return sanitizeCandleSeries(symbol, timeframe, candles);
  }

  private sanitizeLivePayload(
    symbol: string,
    timeframe: Timeframe,
    payload: StreamEventPayload
  ): Candle | null {
    const sanitized = sanitizeCandleSeries(symbol, timeframe, [payload]);
    return sanitized[0] ?? null;
  }

  private cloneCandles(candles: Candle[]): Candle[] {
    return candles.map((candle) => ({ ...candle }));
  }

  private cloneSupportedSymbols(symbols: SupportedSymbol[]): SupportedSymbol[] {
    return symbols.map((symbol) => ({ ...symbol }));
  }

  private getHistoricalCacheKey(request: HistoricalRequest): string {
    return [
      this.getProviderScope(),
      request.symbol.trim().toLowerCase(),
      request.timeframe,
      request.from ?? "null",
      request.to ?? "null",
      request.limit ?? "null",
    ].join(":");
  }

  private setHistoricalCache(key: string, candles: Candle[]) {
    if (this.historicalCache.has(key)) {
      this.historicalCache.delete(key);
    }

    this.historicalCache.set(key, candles);

    while (this.historicalCache.size > HISTORICAL_CACHE_LIMIT) {
      const oldestKey = this.historicalCache.keys().next().value;
      if (!oldestKey) {
        break;
      }

      this.historicalCache.delete(oldestKey);
    }
  }

  async getSupportedSymbols(): Promise<SupportedSymbol[]> {
    if (this.supportedSymbolsCache) {
      return this.cloneSupportedSymbols(this.supportedSymbolsCache);
    }

    try {
      return this.cloneSupportedSymbols(await this.loadSupportedSymbols());
    } catch (error) {
      throw createProviderError("getSupportedSymbols failed", error);
    }
  }

  async getHistorical(request: HistoricalRequest): Promise<Candle[]> {
    try {
      this.assertSupportedTimeframe(request.timeframe);
      const symbol = await this.assertSupportedSymbol(request.symbol);
      const normalizedRequest = {
        ...request,
        symbol,
      };
      const cacheKey = this.getHistoricalCacheKey(normalizedRequest);
      const cached = this.historicalCache.get(cacheKey);

      if (cached) {
        return this.cloneCandles(cached);
      }

      const candles = await invoke<Candle[]>("get_historical", {
        symbol,
        timeframe: request.timeframe,
        from: request.from ?? null,
        to: request.to ?? null,
        limit: request.limit ?? null,
      });
      const sanitized = this.sanitizeHistoricalResult(symbol, request.timeframe, candles);

      this.setHistoricalCache(cacheKey, sanitized);
      return this.cloneCandles(sanitized);
    } catch (error) {
      throw createProviderError(
        `getHistorical failed for ${request.symbol}/${request.timeframe}`,
        error
      );
    }
  }

  async subscribeLive(
    symbol: string,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void
  ): Promise<LiveSubscription> {
    try {
      this.assertSupportedTimeframe(timeframe);
      const normalizedSymbol = await this.assertSupportedSymbol(symbol);
      const key = `${this.getProviderScope()}:${normalizedSymbol}:${timeframe}`;
      const consumerId = this.nextConsumerId++;
      const existing = this.sharedSubscriptions.get(key);

      if (existing) {
        existing.consumers.set(consumerId, onCandle);
        let closed = false;

        return {
          unsubscribe: async () => {
            if (closed) {
              return;
            }

            closed = true;
            existing.consumers.delete(consumerId);

            if (existing.consumers.size > 0) {
              return;
            }

            this.sharedSubscriptions.delete(key);
            existing.unlisten();
            await invoke("unsubscribe_live", { symbol: normalizedSymbol, timeframe });
          },
        };
      }

      const eventName = `candle://${normalizedSymbol}/${timeframe}`;
      const consumers = new Map<number, (candle: Candle) => void>([[consumerId, onCandle]]);
      const unlisten = await listen<StreamEventPayload>(eventName, (event) => {
        const payload = event.payload;

        if (payload.symbol !== normalizedSymbol || payload.timeframe !== timeframe) {
          return;
        }

        const candle = this.sanitizeLivePayload(normalizedSymbol, timeframe, payload);
        if (!candle) {
          return;
        }

        if (DEBUG_LIVE_UPDATES) {
          console.debug("[live:event]", {
            symbol: normalizedSymbol,
            timeframe,
            time: candle.time,
            close: candle.close,
          });
          relayFrontendDebugLog("live:event", {
            symbol: normalizedSymbol,
            timeframe,
            time: candle.time,
            close: candle.close,
          });
        }

        const shared = this.sharedSubscriptions.get(key);
        if (!shared) {
          return;
        }

        for (const callback of shared.consumers.values()) {
          callback(candle);
        }
      });

      try {
        await invoke("subscribe_live", { symbol: normalizedSymbol, timeframe });
      } catch (error) {
        unlisten();
        throw error;
      }

      const sharedSubscription: SharedLiveSubscription = {
        symbol: normalizedSymbol,
        timeframe,
        unlisten,
        consumers,
      };
      this.sharedSubscriptions.set(key, sharedSubscription);

      let closed = false;

      return {
        unsubscribe: async () => {
          if (closed) {
            return;
          }

          closed = true;
          const shared = this.sharedSubscriptions.get(key);
          if (!shared) {
            return;
          }

          shared.consumers.delete(consumerId);

          if (shared.consumers.size > 0) {
            return;
          }

          this.sharedSubscriptions.delete(key);
          shared.unlisten();
          await invoke("unsubscribe_live", { symbol: normalizedSymbol, timeframe });
        },
      };
    } catch (error) {
      throw createProviderError(`subscribeLive failed for ${symbol}/${timeframe}`, error);
    }
  }
}
