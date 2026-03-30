import type { ChartDrawings } from "./drawings";
import type { Timeframe } from "./marketData";

export type PanelState = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
};

export type Workspace = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;

  layoutType: string;
  panels: PanelState[];

  drawingsBySymbol: Record<string, ChartDrawings>;

  theme: {
    mode: "dark" | "light";
    preset: "professional" | "premium" | "vibrant" | "monochrome" | "gold" | "ict";
  };
};
