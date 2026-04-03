import type {
  Candle,
  HistoricalRequest,
  ProviderCapabilities,
  SupportedSymbol,
  Timeframe,
} from "../../types/marketData";
import { sanitizeCandleSeries } from "../../utils/candleCache";
import type { LiveSubscription, MarketDataProvider } from "./MarketDataProvider";

type SnapshotManifest = {
  version: number;
  providerMode: "snapshot_replay";
  generatedAt: string;
  symbols: SnapshotManifestSymbol[];
};

type SnapshotManifestSymbol = {
  id: string;
  label: string;
  yahooTicker: string;
  timeframes: SnapshotManifestTimeframe[];
};

type SnapshotManifestTimeframe = {
  timeframe: Timeframe;
  path: string;
  intervalSeconds: number;
  candleCount: number;
  splitIndex: number;
  startTime: number;
  endTime: number;
};

type SnapshotFile = {
  version: number;
  providerMode: "snapshot_replay";
  generatedAt: string;
  symbol: {
    id: string;
    label: string;
    yahooTicker: string;
  };
  timeframe: Timeframe;
  intervalSeconds: number;
  splitIndex: number;
  seedCount: number;
  replayCount: number;
  startTime: number;
  endTime: number;
  candles: Candle[];
};

type SharedReplaySubscription = {
  consumers: Map<number, (candle: Candle) => void>;
  timerId: number | null;
  nextReplayIndex: number;
  replayCandles: Candle[];
};

const SNAPSHOT_MANIFEST_PATH = "/snapshots/manifest.json";
const SUPPORTED_TIMEFRAMES: Timeframe[] = ["15s", "1m", "3m"];
const DEFAULT_REPLAY_SPEED_MS = 350;

function parseReplaySpeedMs(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_REPLAY_SPEED_MS;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REPLAY_SPEED_MS;
}

const SNAPSHOT_REPLAY_SPEED_MS = parseReplaySpeedMs(
  import.meta.env.VITE_SNAPSHOT_REPLAY_SPEED_MS
);

function createProviderError(scope: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[SnapshotReplayProvider] ${scope}: ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeSupportedSymbols(symbols: SnapshotManifestSymbol[]): SupportedSymbol[] {
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

function normalizeSupportedTimeframes(symbols: SnapshotManifestSymbol[]): Timeframe[] {
  const seen = new Set<Timeframe>();
  const normalized: Timeframe[] = [];
  const canDerive15s = symbols.some((symbol) =>
    symbol.timeframes.some((entry) => entry.timeframe === "1m" || entry.timeframe === "15s")
  );

  if (canDerive15s) {
    seen.add("15s");
    normalized.push("15s");
  }

  for (const symbol of symbols) {
    for (const entry of symbol.timeframes) {
      const timeframe = entry.timeframe;
      if (!SUPPORTED_TIMEFRAMES.includes(timeframe) || seen.has(timeframe)) {
        continue;
      }

      seen.add(timeframe);
      normalized.push(timeframe);
    }
  }

  return normalized;
}

function cloneCandles(candles: Candle[]): Candle[] {
  return candles.map((candle) => ({ ...candle }));
}

function splitVolume(volume: number | undefined): number[] {
  const safeVolume = typeof volume === "number" && Number.isFinite(volume) ? volume : 0;
  const quarter = safeVolume / 4;
  return [quarter, quarter, quarter, safeVolume - quarter * 3];
}

function subdivideMinuteCandlesTo15s(candles: Candle[]): Candle[] {
  return candles.flatMap((candle) => {
    const path =
      candle.close >= candle.open
        ? [
            candle.open,
            (candle.open + candle.low) / 2,
            candle.low,
            candle.high,
            candle.close,
          ]
        : [
            candle.open,
            (candle.open + candle.high) / 2,
            candle.high,
            candle.low,
            candle.close,
          ];
    const volumeParts = splitVolume(candle.volume);

    return Array.from({ length: 4 }, (_, index) => {
      const segmentOpen = path[index] ?? candle.open;
      const segmentClose = path[index + 1] ?? candle.close;

      return {
        symbol: candle.symbol,
        time: candle.time + index * 15,
        open: segmentOpen,
        high: Math.max(segmentOpen, segmentClose),
        low: Math.min(segmentOpen, segmentClose),
        close: segmentClose,
        volume: volumeParts[index],
      } satisfies Candle;
    });
  });
}

function filterByRequestWindow(candles: Candle[], request: HistoricalRequest): Candle[] {
  const from = request.from ?? null;
  const to = request.to ?? null;
  const limit = request.limit ?? null;

  let filtered = candles.filter((candle) => {
    if (from !== null && candle.time < from) {
      return false;
    }

    if (to !== null && candle.time > to) {
      return false;
    }

    return true;
  });

  if (limit !== null && limit > 0 && filtered.length > limit) {
    filtered = filtered.slice(filtered.length - limit);
  }

  return filtered;
}

export class SnapshotReplayProvider implements MarketDataProvider {
  private manifestPromise: Promise<SnapshotManifest> | null = null;
  private snapshotCache = new Map<string, SnapshotFile>();
  private sharedSubscriptions = new Map<string, SharedReplaySubscription>();
  private nextConsumerId = 1;

  private assertSupportedTimeframe(timeframe: Timeframe): void {
    if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }
  }

  private async loadManifest(): Promise<SnapshotManifest> {
    if (!this.manifestPromise) {
      this.manifestPromise = fetch(SNAPSHOT_MANIFEST_PATH, {
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`manifest fetch failed with ${response.status}`);
          }

          const raw = (await response.json()) as SnapshotManifest;
          if (
            !raw ||
            raw.providerMode !== "snapshot_replay" ||
            !Array.isArray(raw.symbols) ||
            raw.symbols.length === 0
          ) {
            throw new Error("invalid snapshot manifest");
          }

          return raw;
        })
        .catch((error) => {
          this.manifestPromise = null;
          throw error;
        });
    }

    return this.manifestPromise;
  }

  private async getManifestSymbol(symbol: string): Promise<SnapshotManifestSymbol> {
    const manifest = await this.loadManifest();
    const normalizedSymbol = symbol.trim().toLowerCase();
    const entry = manifest.symbols.find((item) => item.id.trim().toLowerCase() === normalizedSymbol);

    if (!entry) {
      throw new Error(`Unsupported symbol: ${symbol}`);
    }

    return entry;
  }

  private async getSnapshot(symbol: string, timeframe: Timeframe): Promise<SnapshotFile> {
    this.assertSupportedTimeframe(timeframe);

    const normalizedSymbol = symbol.trim().toLowerCase();
    const key = `${normalizedSymbol}:${timeframe}`;
    const cached = this.snapshotCache.get(key);
    if (cached) {
      return cached;
    }

    const manifestSymbol = await this.getManifestSymbol(normalizedSymbol);
    const timeframeEntry = manifestSymbol.timeframes.find((entry) => entry.timeframe === timeframe);
    if (!timeframeEntry && timeframe === "15s") {
      const minuteSnapshot = await this.getSnapshot(normalizedSymbol, "1m");
      const expandedCandles = sanitizeCandleSeries(
        manifestSymbol.id,
        timeframe,
        subdivideMinuteCandlesTo15s(minuteSnapshot.candles)
      );
      const splitIndex = Math.max(
        1,
        Math.min(minuteSnapshot.splitIndex * 4, expandedCandles.length - 1)
      );
      const derivedSnapshot: SnapshotFile = {
        ...minuteSnapshot,
        timeframe,
        intervalSeconds: 15,
        splitIndex,
        seedCount: splitIndex,
        replayCount: expandedCandles.length - splitIndex,
        startTime: expandedCandles[0]?.time ?? minuteSnapshot.startTime,
        endTime: expandedCandles[expandedCandles.length - 1]?.time ?? minuteSnapshot.endTime,
        candles: expandedCandles,
      };

      this.snapshotCache.set(key, derivedSnapshot);
      return derivedSnapshot;
    }

    if (!timeframeEntry) {
      throw new Error(`Unsupported timeframe for ${normalizedSymbol}: ${timeframe}`);
    }

    const response = await fetch(timeframeEntry.path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`snapshot fetch failed with ${response.status}`);
    }

    const raw = (await response.json()) as SnapshotFile;
    if (
      !raw ||
      raw.providerMode !== "snapshot_replay" ||
      !Array.isArray(raw.candles) ||
      !isFiniteNumber(raw.splitIndex)
    ) {
      throw new Error(`Invalid snapshot payload for ${normalizedSymbol}/${timeframe}`);
    }

    const candles = sanitizeCandleSeries(
      manifestSymbol.id,
      timeframe,
      raw.candles.map((candle) => ({
        symbol: manifestSymbol.id,
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }))
    );

    if (candles.length < 2) {
      throw new Error(`Snapshot payload for ${normalizedSymbol}/${timeframe} has too few candles`);
    }

    const splitIndex = Math.max(1, Math.min(raw.splitIndex, candles.length - 1));
    const snapshot: SnapshotFile = {
      ...raw,
      symbol: {
        ...raw.symbol,
        id: manifestSymbol.id,
        label: manifestSymbol.label,
        yahooTicker:
          typeof raw.symbol?.yahooTicker === "string" && raw.symbol.yahooTicker.trim().length > 0
            ? raw.symbol.yahooTicker.trim()
            : manifestSymbol.yahooTicker,
      },
      timeframe,
      candles,
      splitIndex,
      seedCount: splitIndex,
      replayCount: candles.length - splitIndex,
      startTime: candles[0]?.time ?? raw.startTime,
      endTime: candles[candles.length - 1]?.time ?? raw.endTime,
    };

    this.snapshotCache.set(key, snapshot);
    return snapshot;
  }

  private getSeedCandles(snapshot: SnapshotFile): Candle[] {
    return snapshot.candles.slice(0, snapshot.splitIndex);
  }

  private getReplayCandles(snapshot: SnapshotFile): Candle[] {
    return snapshot.candles.slice(snapshot.splitIndex);
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    try {
      const manifest = await this.loadManifest();

      return {
        providerMode: "snapshot_replay",
        supportedSymbols: normalizeSupportedSymbols(manifest.symbols),
        supportedTimeframes: normalizeSupportedTimeframes(manifest.symbols),
        liveSupported: true,
        notice: "Snapshot replay mode: local frozen market dataset.",
        validationMode: false,
        strictRealtime: false,
        liveSource: "snapshot_replay",
        pollIntervalMs: SNAPSHOT_REPLAY_SPEED_MS,
      };
    } catch (error) {
      throw createProviderError("getCapabilities failed", error);
    }
  }

  async getSupportedSymbols(): Promise<SupportedSymbol[]> {
    try {
      const manifest = await this.loadManifest();
      return normalizeSupportedSymbols(manifest.symbols).map((symbol) => ({ ...symbol }));
    } catch (error) {
      throw createProviderError("getSupportedSymbols failed", error);
    }
  }

  async getHistorical(request: HistoricalRequest): Promise<Candle[]> {
    try {
      const normalizedSymbol = request.symbol.trim().toLowerCase();
      const snapshot = await this.getSnapshot(normalizedSymbol, request.timeframe);

      // Historical reads stay pinned to the seed segment so replay candles never
      // leak through the history API, even if the app requests the latest window again.
      return cloneCandles(
        filterByRequestWindow(this.getSeedCandles(snapshot), {
          ...request,
          symbol: normalizedSymbol,
        })
      );
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

      const normalizedSymbol = symbol.trim().toLowerCase();
      const key = `snapshot_replay:${normalizedSymbol}:${timeframe}`;
      const consumerId = this.nextConsumerId++;
      const existing = this.sharedSubscriptions.get(key);

      if (existing) {
        existing.consumers.set(consumerId, onCandle);
        return this.createUnsubscriber(key, consumerId);
      }

      const snapshot = await this.getSnapshot(normalizedSymbol, timeframe);
      const replayCandles = this.getReplayCandles(snapshot);
      const shared: SharedReplaySubscription = {
        consumers: new Map([[consumerId, onCandle]]),
        timerId: null,
        nextReplayIndex: 0,
        replayCandles,
      };

      const tick = () => {
        if (shared.nextReplayIndex >= shared.replayCandles.length) {
          if (shared.timerId !== null) {
            window.clearInterval(shared.timerId);
            shared.timerId = null;
          }
          return;
        }

        const candle = shared.replayCandles[shared.nextReplayIndex];
        shared.nextReplayIndex += 1;

        for (const callback of shared.consumers.values()) {
          callback({ ...candle });
        }

        if (shared.nextReplayIndex >= shared.replayCandles.length && shared.timerId !== null) {
          window.clearInterval(shared.timerId);
          shared.timerId = null;
        }
      };

      shared.timerId = window.setInterval(tick, SNAPSHOT_REPLAY_SPEED_MS);
      this.sharedSubscriptions.set(key, shared);

      return this.createUnsubscriber(key, consumerId);
    } catch (error) {
      throw createProviderError(`subscribeLive failed for ${symbol}/${timeframe}`, error);
    }
  }

  private createUnsubscriber(key: string, consumerId: number): LiveSubscription {
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

        if (shared.timerId !== null) {
          window.clearInterval(shared.timerId);
        }

        this.sharedSubscriptions.delete(key);
      },
    };
  }
}
