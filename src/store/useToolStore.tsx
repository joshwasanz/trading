import { create } from "zustand";

export type ToolType = "none" | "trendline" | "rectangle";

type ToolState = {
  tool: ToolType;
  setTool: (tool: ToolType) => void;
};

export const useToolStore = create<ToolState>((set) => ({
  tool: "none",

  setTool: (tool) => set({ tool }),
}));