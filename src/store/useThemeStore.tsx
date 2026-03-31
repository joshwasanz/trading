import { create } from "zustand";
import { createTheme, ThemeMode, ThemePreset } from "../theme/theme";

const STORAGE_KEY = "theme_preferences_v1";

type State = {
  mode: ThemeMode;
  preset: ThemePreset;
  theme: ReturnType<typeof createTheme>;

  setMode: (mode: ThemeMode) => void;
  setPreset: (preset: ThemePreset) => void;
};

type ThemePreferences = {
  mode: ThemeMode;
  preset: ThemePreset;
};

function loadThemePreferences(): ThemePreferences {
  if (typeof window === "undefined") {
    return {
      mode: "dark",
      preset: "professional",
    };
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return {
        mode: "dark",
        preset: "professional",
      };
    }

    const parsed = JSON.parse(stored) as Partial<ThemePreferences>;
    const mode = parsed.mode === "light" ? "light" : "dark";
    const preset: ThemePreset =
      parsed.preset === "premium" ||
      parsed.preset === "vibrant" ||
      parsed.preset === "monochrome" ||
      parsed.preset === "gold" ||
      parsed.preset === "ict"
        ? parsed.preset
        : "professional";

    return { mode, preset };
  } catch (error) {
    console.error("[ThemeStore] Failed to load theme preferences:", error);
    return {
      mode: "dark",
      preset: "professional",
    };
  }
}

function persistThemePreferences(preferences: ThemePreferences) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error("[ThemeStore] Failed to persist theme preferences:", error);
  }
}

const initialPreferences = loadThemePreferences();

export const useThemeStore = create<State>((set, get) => ({
  ...initialPreferences,

  theme: createTheme(initialPreferences.mode, initialPreferences.preset),

  setMode: (mode) =>
    set(() => {
      const next = {
        mode,
        preset: get().preset,
      };
      persistThemePreferences(next);
      return {
        mode,
        theme: createTheme(mode, next.preset),
      };
    }),

  setPreset: (preset) =>
    set(() => {
      const next = {
        mode: get().mode,
        preset,
      };
      persistThemePreferences(next);
      return {
        preset,
        theme: createTheme(next.mode, preset),
      };
    }),
}));
