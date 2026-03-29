import { create } from "zustand";
import { createTheme, ThemeMode, ThemePreset } from "../theme/theme";

type State = {
  mode: ThemeMode;
  preset: ThemePreset;
  theme: ReturnType<typeof createTheme>;

  setMode: (mode: ThemeMode) => void;
  setPreset: (preset: ThemePreset) => void;
};

export const useThemeStore = create<State>((set, get) => ({
  mode: "dark",
  preset: "professional",

  theme: createTheme("dark", "professional"),

  setMode: (mode) =>
    set(() => ({
      mode,
      theme: createTheme(mode, get().preset),
    })),

  setPreset: (preset) =>
    set(() => ({
      preset,
      theme: createTheme(get().mode, preset),
    })),
}));