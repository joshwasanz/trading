import { SnapshotReplayProvider } from "./SnapshotReplayProvider";
import { TauriMarketDataProvider } from "./TauriMarketDataProvider";

export type MarketDataBackend = "tauri" | "snapshot_replay";

function resolveMarketDataBackend(): MarketDataBackend {
  const configuredProvider = String(import.meta.env.VITE_DATA_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  return configuredProvider === "snapshot_replay" ? "snapshot_replay" : "tauri";
}

export function createMarketDataProvider(backend: MarketDataBackend = resolveMarketDataBackend()) {
  switch (backend) {
    case "snapshot_replay":
      return new SnapshotReplayProvider();
    case "tauri":
    default:
      return new TauriMarketDataProvider();
  }
}

export const marketDataProvider = createMarketDataProvider();
