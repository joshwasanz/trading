import { TauriMarketDataProvider } from "./TauriMarketDataProvider";

export type MarketDataBackend = "tauri";

export function createMarketDataProvider(backend: MarketDataBackend = "tauri") {
  switch (backend) {
    case "tauri":
    default:
      return new TauriMarketDataProvider();
  }
}

export const marketDataProvider = createMarketDataProvider();
