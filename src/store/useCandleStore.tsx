import { create } from "zustand";
import type { Candle, ProviderMode, Timeframe } from "../types/marketData";
import {
  FREE_TIER_VALIDATION_MODE,
  isValidationModeSymbolAllowed,
  normalizeInstrumentId,
} from "../instruments";
import {
  clearLegacyMarketDataCaches,
  loadScopedCandleCache,
  persistScopedCandleCache,
  sanitizeCachedCandleData,
} from "../utils/candleCache";

type CandleData = Record<string, Partial<Record<Timeframe, Candle[]>>>;

type State = {
  data: CandleData;
  providerMode: ProviderMode | null;
  setData: (symbol: string, tf: Timeframe, candles: Candle[]) => void;
  loadFromCache: (providerMode: ProviderMode) => void;
};

const STORAGE_KEY = "candle_cache_v3";
const LEGACY_STORAGE_KEYS = ["candle_cache_v1", "candle_cache_v2"];

function normalizeCachedData(value: unknown): CandleData {
  return Object.entries(sanitizeCachedCandleData(value)).reduce<CandleData>(
    (next, [symbol, series]) => {
      const normalizedSymbol = normalizeInstrumentId(symbol);
      if (FREE_TIER_VALIDATION_MODE && !isValidationModeSymbolAllowed(normalizedSymbol)) {
        return next;
      }

      const filteredSeries = {
        "1m": series["1m"],
        "3m": series["3m"],
      };

      next[normalizedSymbol] = {
        ...next[normalizedSymbol],
        ...(FREE_TIER_VALIDATION_MODE ? filteredSeries : series),
      };
      return next;
    },
    {}
  );
}

function loadFromLocalStorage(providerMode: ProviderMode): CandleData {
  if (typeof window === "undefined") return {};

  try {
    return normalizeCachedData(
      loadScopedCandleCache(
        window.localStorage,
        STORAGE_KEY,
        LEGACY_STORAGE_KEYS,
        providerMode
      )
    );
  } catch (error) {
    console.error("[CandleStore] Failed to load cache:", error);
    return {};
  }
}

export const useCandleStore = create<State>((set) => ({
  data: {},
  providerMode: null,

  setData: (symbol, tf, candles) =>
    set((state) => {
      const updated = {
        ...state.data,
        [symbol]: {
          ...state.data[symbol],
          [tf]: candles,
        },
      };

      // Persist to localStorage
      try {
        if (state.providerMode) {
          persistScopedCandleCache(
            window.localStorage,
            STORAGE_KEY,
            LEGACY_STORAGE_KEYS,
            state.providerMode,
            updated
          );
        } else {
          clearLegacyMarketDataCaches(window.localStorage, LEGACY_STORAGE_KEYS);
        }
      } catch (error) {
        console.error("[CandleStore] Failed to save cache:", error);
      }

      return { data: updated };
    }),

  loadFromCache: (providerMode) => {
    const cached = loadFromLocalStorage(providerMode);
    set({ data: cached, providerMode });
  },
}));
