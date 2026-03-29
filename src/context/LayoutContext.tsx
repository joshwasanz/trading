import { createContext, useContext } from "react";
import type { DrawingsState } from "../types/drawings";

type Panel = {
  id: string;
  symbol: string;
  timeframe: "15s" | "1m" | "3m";
};

type LayoutContextType = {
  panels: Panel[];
  drawingsBySymbol: DrawingsState;
};

export const LayoutContext = createContext<LayoutContextType | null>(null);

export function useLayoutContext() {
  const context = useContext(LayoutContext);
  // Return empty context if not available instead of throwing
  return context || { panels: [], drawingsBySymbol: {} };
}
