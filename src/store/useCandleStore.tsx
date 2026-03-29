import { create } from "zustand";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type CandleData = Record<string, Record<string, Candle[]>>;

type State = {
  data: CandleData;
  setData: (symbol: string, tf: string, candles: Candle[]) => void;
  loadFromCache: () => void;
};

const STORAGE_KEY = "candle_cache_v1";

function loadFromLocalStorage(): CandleData {
  if (typeof window === "undefined") return {};

  try {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached) {
      return JSON.parse(cached);
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
