import { create } from "zustand";

export type ToolType = "none" | "trendline" | "rectangle";

type ToolState = {
  tool: ToolType;
  setTool: (tool: ToolType) => void;
  magnet: boolean;
  setMagnet: (enabled: boolean) => void;
};

export const useToolStore = create<ToolState>((set) => ({
  tool: "none",
  magnet: false,

  setTool: (tool) => set({ tool }),
  setMagnet: (magnet) => set({ magnet }),
}));
