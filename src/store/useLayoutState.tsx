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
  focusedPanelId: string | null;

  setPanels: (panels: Panel[]) => void;
  setDrawingsBySymbol: (drawings: DrawingsState) => void;
  setFocusedPanelId: (focusedPanelId: string | null) => void;
};

export const useLayoutState = create<State>((set) => ({
  panels: [],
  drawingsBySymbol: {},
  focusedPanelId: null,

  setPanels: (panels) => set({ panels }),
  setDrawingsBySymbol: (drawingsBySymbol) => set({ drawingsBySymbol }),
  setFocusedPanelId: (focusedPanelId) => set({ focusedPanelId }),
}));
