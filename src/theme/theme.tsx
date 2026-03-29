export type ThemeMode = "dark" | "light";
export type ThemePreset = "professional" | "premium" | "vibrant" | "monochrome" | "gold" | "ict";

export type Theme = {
  mode: ThemeMode;
  preset: ThemePreset;
  background: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  grid: string;
  accent: string;
  candleUp: string;
  candleDown: string;
  wickUp: string;
  wickDown: string;
};

const presets: Record<
  ThemePreset,
  {
    accent: string;
    candleUp: string;
    candleDown: string;
    darkModeAccent?: string;
    darkModeCandleUp?: string;
    lightModeAccent?: string;
    lightModeCandleUp?: string;
    lightModeCandleDown?: string;
  }
> = {
  professional: {
    accent: "#4da3ff",
    candleUp: "#4da3ff",
    candleDown: "#ff4d6d",
  },
  premium: {
    accent: "#a855f7",
    candleUp: "#a855f7",
    candleDown: "#f87171",
    darkModeAccent: "#a855f7",
    darkModeCandleUp: "#c084fc",
  },
  vibrant: {
    accent: "#ec4899",
    candleUp: "#ec4899",
    candleDown: "#ef4444",
    darkModeAccent: "#ec4899",
    darkModeCandleUp: "#f472b6",
  },
  monochrome: {
    accent: "#888888",
    candleUp: "#ffffff",
    candleDown: "#888888",
    lightModeAccent: "#666666",
    lightModeCandleUp: "#000000",
    lightModeCandleDown: "#888888",
  },
  gold: {
    accent: "#f59e0b",
    candleUp: "#fbbf24",
    candleDown: "#ef4444",
  },
  ict: {
    accent: "#22c55e",
    candleUp: "#22c55e",
    candleDown: "#ef4444",
    darkModeAccent: "#22c55e",
    lightModeAccent: "#16a34a",
    lightModeCandleDown: "#000000",
  },
};

export const createTheme = (mode: ThemeMode, preset: ThemePreset): Theme => {
  const p = presets[preset];

  // Determine colors based on mode and preset
  let accentColor = p.accent;
  let candleUpColor = p.candleUp;
  let candleDownColor = p.candleDown;

  // Apply dark mode overrides
  if (mode === "dark" && p.darkModeAccent) {
    accentColor = p.darkModeAccent;
  }
  if (mode === "dark" && p.darkModeCandleUp) {
    candleUpColor = p.darkModeCandleUp;
  }

  // Apply light mode overrides
  if (mode === "light" && p.lightModeAccent) {
    accentColor = p.lightModeAccent;
  }
  if (mode === "light" && p.lightModeCandleUp) {
    candleUpColor = p.lightModeCandleUp;
  }
  if (mode === "light" && p.lightModeCandleDown) {
    candleDownColor = p.lightModeCandleDown;
  }

  const base: Theme = {
    mode,
    preset,
    background: mode === "dark" ? "#0f1014" : "#ffffff",
    panel: mode === "dark" ? "#13151a" : "#f6f7fb",
    border: mode === "dark" ? "#2a2d34" : "#dcdfe6",
    text: mode === "dark" ? "#d4d7de" : "#1c1f26",
    muted: mode === "dark" ? "#7f8591" : "#6b7280",
    grid: mode === "dark" ? "#1c1f26" : "#e5e7eb",
    accent: accentColor,
    candleUp: candleUpColor,
    candleDown: candleDownColor,
    wickUp: candleUpColor,
    wickDown: candleDownColor,
  };

  // Light mode: use black for bearish candles for strong contrast (unless overridden)
  if (mode === "light" && !p.lightModeCandleDown) {
    return {
      ...base,
      candleDown: "#111111",
      wickDown: "#111111",
    };
  }

  return base;
};