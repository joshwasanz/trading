import { create } from "zustand";
import type { Candle, Timeframe } from "../types/marketData";
import { normalizeInstrumentId } from "../instruments";
import {
  clearLegacyMarketDataCaches,
  sanitizeCachedCandleData,
} from "../utils/candleCache";

type CandleData = Record<string, Partial<Record<Timeframe, Candle[]>>>;

type State = {
  data: CandleData;
  setData: (symbol: string, tf: Timeframe, candles: Candle[]) => void;
  loadFromCache: () => void;
};

const STORAGE_KEY = "candle_cache_v2";
const LEGACY_STORAGE_KEYS = ["candle_cache_v1"];

function loadFromLocalStorage(): CandleData {
  if (typeof window === "undefined") return {};

  try {
    clearLegacyMarketDataCaches(window.localStorage, LEGACY_STORAGE_KEYS);
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached) {
      return Object.entries(sanitizeCachedCandleData(JSON.parse(cached))).reduce<CandleData>(
        (next, [symbol, series]) => {
          next[normalizeInstrumentId(symbol)] = {
            ...next[normalizeInstrumentId(symbol)],
            ...series,
          };
          return next;
        },
        {}
      );
    }
  } catch (error) {
    console.error("[CandleStore] Failed to load cache:", error);
  }

  return {};
}

export const useCandleStore = create<State>((set) => ({
  data: loadFromLocalStorage(),

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
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[CandleStore] Failed to save cache:", error);
      }

      return { data: updated };
    }),

  loadFromCache: () => {
    const cached = loadFromLocalStorage();
    set({ data: cached });
  },
}));
