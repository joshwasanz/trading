import type { SupportedSymbol, Timeframe } from "./types/marketData";

export type InstrumentAssetClass = "forex" | "index";

export type InstrumentDefinition = {
  id: string;
  label: string;
  assetClass: InstrumentAssetClass;
  enabled: boolean;
  aliases?: string[];
};

export type InstrumentPanel = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
};

export const FREE_TIER_VALIDATION_MODE =
  import.meta.env.VITE_FREE_TIER_VALIDATION_MODE === "true";
export const VALIDATION_ALLOWED_SYMBOL_IDS = ["eurusd", "usdjpy"] as const;
export const VALIDATION_DEFAULT_PANEL: InstrumentPanel = {
  id: "A",
  symbol: "eurusd",
  timeframe: "1m",
};
export const DEFAULT_LAYOUT_TYPE = FREE_TIER_VALIDATION_MODE ? "1" : "2";

export const INSTRUMENT_DEFINITIONS: InstrumentDefinition[] = [
  { id: "eurusd", label: "EUR/USD", assetClass: "forex", enabled: true },
  { id: "usdjpy", label: "USD/JPY", assetClass: "forex", enabled: true },
  { id: "spx", label: "S&P 500", assetClass: "index", enabled: true, aliases: ["es"] },
  { id: "ndx", label: "Nasdaq-100", assetClass: "index", enabled: true, aliases: ["nq"] },
  { id: "gbpusd", label: "GBP/USD", assetClass: "forex", enabled: false },
  { id: "usdchf", label: "USD/CHF", assetClass: "forex", enabled: false },
  { id: "audusd", label: "AUD/USD", assetClass: "forex", enabled: false },
  { id: "usdcad", label: "USD/CAD", assetClass: "forex", enabled: false },
  { id: "dji", label: "Dow Jones", assetClass: "index", enabled: false },
];

let instrumentIdAliasesCache: Record<string, string> | null = null;

function getInstrumentIdAliases(): Record<string, string> {
  if (instrumentIdAliasesCache) {
    return instrumentIdAliasesCache;
  }

  instrumentIdAliasesCache = Object.fromEntries(
    INSTRUMENT_DEFINITIONS.flatMap((instrument) =>
      (instrument.aliases ?? []).map((alias) => [alias, instrument.id])
    )
  ) as Record<string, string>;

  return instrumentIdAliasesCache;
}

export function normalizeInstrumentId(symbol: string): string {
  const normalized = symbol.trim().toLowerCase();
  return getInstrumentIdAliases()[normalized] ?? normalized;
}

export function isValidationModeSymbolAllowed(symbol: string): boolean {
  const normalized = normalizeInstrumentId(symbol);
  return (VALIDATION_ALLOWED_SYMBOL_IDS as readonly string[]).includes(normalized);
}

export function validationModeRejection(
  symbol: string,
  timeframe: Timeframe
): string | null {
  if (!FREE_TIER_VALIDATION_MODE) {
    return null;
  }

  const normalizedSymbol = normalizeInstrumentId(symbol);
  const validationSymbol = normalizedSymbol.trim().toLowerCase();
  if (!isValidationModeSymbolAllowed(validationSymbol)) {
    return `Validation mode only supports EURUSD and USDJPY. Blocked ${normalizedSymbol.toUpperCase()}.`;
  }

  if (!["15s", "1m", "3m"].includes(timeframe)) {
    return `Validation mode only supports 15s, 1m, and 3m for ${normalizedSymbol.toUpperCase()}.`;
  }

  return null;
}

export const DEFAULT_SUPPORTED_SYMBOLS: SupportedSymbol[] = INSTRUMENT_DEFINITIONS
  .filter((instrument) => instrument.enabled)
  .filter((instrument) => !FREE_TIER_VALIDATION_MODE || isValidationModeSymbolAllowed(instrument.id))
  .map(({ id, label }) => ({ id, label }));

export const DEFAULT_SUPPORTED_SYMBOL_IDS = DEFAULT_SUPPORTED_SYMBOLS.map(({ id }) => id);

export const DEFAULT_PANELS: InstrumentPanel[] = FREE_TIER_VALIDATION_MODE
  ? [VALIDATION_DEFAULT_PANEL]
  : [
      { id: "A", symbol: "eurusd", timeframe: "1m" },
      { id: "B", symbol: "spx", timeframe: "1m" },
      { id: "C", symbol: "usdjpy", timeframe: "1m" },
      { id: "D", symbol: "ndx", timeframe: "1m" },
      { id: "E", symbol: "eurusd", timeframe: "3m" },
      { id: "F", symbol: "usdjpy", timeframe: "3m" },
    ];

function instrumentDefinitionForSymbol(symbol: string): InstrumentDefinition | undefined {
  const normalized = normalizeInstrumentId(symbol);
  return INSTRUMENT_DEFINITIONS.find((instrument) => instrument.id === normalized);
}

export function instrumentAssetClassForSymbol(symbol: string): InstrumentAssetClass | null {
  return instrumentDefinitionForSymbol(symbol)?.assetClass ?? null;
}

export function allowedTimeframesForInstrument(symbol: string): Timeframe[] {
  if (FREE_TIER_VALIDATION_MODE) {
    return isValidationModeSymbolAllowed(symbol) ? ["15s", "1m", "3m"] : [];
  }

  switch (instrumentAssetClassForSymbol(symbol)) {
    case "forex":
    case "index":
    default:
      return ["15s", "1m", "3m"];
  }
}

export function filterSupportedTimeframesForInstrument(
  symbol: string,
  supportedTimeframes: Timeframe[]
): Timeframe[] {
  const allowed = new Set(allowedTimeframesForInstrument(symbol));
  const filtered = supportedTimeframes.filter((timeframe) => allowed.has(timeframe));
  return filtered.length > 0 ? filtered : allowedTimeframesForInstrument(symbol);
}

export function normalizeInstrumentPanels<T extends { symbol: string }>(panels: T[]): T[] {
  return panels.map((panel) => ({
    ...panel,
    symbol: normalizeInstrumentId(panel.symbol),
  }));
}

export function sanitizePanelsForCapabilities<T extends { symbol: string; timeframe: Timeframe }>(
  panels: T[],
  supportedSymbols: SupportedSymbol[],
  supportedTimeframes: Timeframe[]
): T[] {
  const normalizedPanels = normalizeInstrumentPanels(panels);
  const normalizedSymbols = supportedSymbols.map((symbol) => normalizeInstrumentId(symbol.id));
  const allowedSymbols = new Set(normalizedSymbols);
  const fallbackSymbol = normalizedSymbols[0] ?? DEFAULT_SUPPORTED_SYMBOL_IDS[0] ?? "eurusd";

  if (FREE_TIER_VALIDATION_MODE) {
    const seedPanel = normalizedPanels[0] ?? ({ ...VALIDATION_DEFAULT_PANEL } as unknown as T);
    const symbol =
      allowedSymbols.has(seedPanel.symbol) && isValidationModeSymbolAllowed(seedPanel.symbol)
        ? seedPanel.symbol
        : fallbackSymbol;
    const allowedTimeframes = filterSupportedTimeframesForInstrument(symbol, supportedTimeframes);
    const timeframe = allowedTimeframes.includes(seedPanel.timeframe)
      ? seedPanel.timeframe
      : allowedTimeframes[0] ?? VALIDATION_DEFAULT_PANEL.timeframe;

    return [
      {
        ...seedPanel,
        id: "A",
        symbol,
        timeframe,
      },
    ] as T[];
  }

  return normalizedPanels.map((panel, index) => {
    const symbol =
      allowedSymbols.size === 0 || allowedSymbols.has(panel.symbol)
        ? panel.symbol
        : normalizedSymbols[index % normalizedSymbols.length] ?? fallbackSymbol;
    const allowedTimeframes = filterSupportedTimeframesForInstrument(symbol, supportedTimeframes);
    const fallbackTimeframe = allowedTimeframes[0] ?? "1m";
    const timeframe = allowedTimeframes.includes(panel.timeframe)
      ? panel.timeframe
      : fallbackTimeframe;

    return {
      ...panel,
      symbol,
      timeframe,
    };
  });
}
