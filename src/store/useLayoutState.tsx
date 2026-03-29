import { create } from "zustand";
import type { DrawingsState } from "../types/drawings";

type Panel = {
  id: string;
  symbol: string;
  timeframe: "15s" | "1m" | "3m";
};

type State = {
  panels: Panel[];
  drawingsBySymbol: DrawingsState;

  setPanels: (panels: Panel[]) => void;
  setDrawingsBySymbol: (drawings: DrawingsState) => void;
};

export const useLayoutState = create<State>((set) => ({
  panels: [],
  drawingsBySymbol: {},

  setPanels: (panels) => set({ panels }),
  setDrawingsBySymbol: (drawingsBySymbol) => set({ drawingsBySymbol }),
}));
