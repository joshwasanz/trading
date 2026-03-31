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

export const DEFAULT_SUPPORTED_SYMBOLS: SupportedSymbol[] = INSTRUMENT_DEFINITIONS
  .filter((instrument) => instrument.enabled)
  .map(({ id, label }) => ({ id, label }));

export const DEFAULT_SUPPORTED_SYMBOL_IDS = DEFAULT_SUPPORTED_SYMBOLS.map(({ id }) => id);

export const DEFAULT_PANELS: InstrumentPanel[] = [
  { id: "A", symbol: "eurusd", timeframe: "15s" },
  { id: "B", symbol: "spx", timeframe: "15s" },
  { id: "C", symbol: "usdjpy", timeframe: "1m" },
  { id: "D", symbol: "ndx", timeframe: "1m" },
  { id: "E", symbol: "eurusd", timeframe: "3m" },
  { id: "F", symbol: "spx", timeframe: "3m" },
];

const INSTRUMENT_ID_ALIASES = Object.fromEntries(
  INSTRUMENT_DEFINITIONS.flatMap((instrument) =>
    (instrument.aliases ?? []).map((alias) => [alias, instrument.id])
  )
) as Record<string, string>;

export function normalizeInstrumentId(symbol: string): string {
  const normalized = symbol.trim().toLowerCase();
  return INSTRUMENT_ID_ALIASES[normalized] ?? normalized;
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
  const allowedTimeframes = new Set(supportedTimeframes);
  const fallbackSymbol = normalizedSymbols[0] ?? DEFAULT_SUPPORTED_SYMBOL_IDS[0] ?? "eurusd";
  const fallbackTimeframe = supportedTimeframes[0] ?? "1m";

  return normalizedPanels.map((panel, index) => {
    const symbol =
      allowedSymbols.size === 0 || allowedSymbols.has(panel.symbol)
        ? panel.symbol
        : normalizedSymbols[index % normalizedSymbols.length] ?? fallbackSymbol;
    const timeframe =
      allowedTimeframes.size === 0 || allowedTimeframes.has(panel.timeframe)
        ? panel.timeframe
        : fallbackTimeframe;

    return {
      ...panel,
      symbol,
      timeframe,
    };
  });
}
