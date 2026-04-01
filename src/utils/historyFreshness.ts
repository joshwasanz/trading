import type { HistoricalRequest, Timeframe } from "../types/marketData";

export type LatestWindowRangeType = "latest";

export type LatestWindowFetchMeta = {
  fetchedAt: number;
  limit: number;
  newest: number | null;
  rangeType: LatestWindowRangeType;
};

export function isLatestWindowRequest(
  request: Pick<HistoricalRequest, "from" | "to">
): boolean {
  return request.from == null && request.to == null;
}

export function getLatestWindowTtlMs(timeframe: Timeframe): number {
  switch (timeframe) {
    case "15s":
      return 30_000;
    case "1m":
      return 90_000;
    case "3m":
      return 240_000;
    default:
      return 60_000;
  }
}

export function isLatestWindowFetchFresh(
  meta: LatestWindowFetchMeta | null | undefined,
  timeframe: Timeframe,
  requiredLimit: number,
  now = Date.now()
): boolean {
  if (!meta || meta.rangeType !== "latest") {
    return false;
  }

  if (!Number.isFinite(meta.fetchedAt) || meta.fetchedAt <= 0) {
    return false;
  }

  if (!Number.isFinite(meta.limit) || meta.limit < requiredLimit) {
    return false;
  }

  return now - meta.fetchedAt <= getLatestWindowTtlMs(timeframe);
}

export function sanitizeLatestWindowFetchMeta(value: unknown): LatestWindowFetchMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const maybe = value as Partial<LatestWindowFetchMeta>;
  const fetchedAt =
    typeof maybe.fetchedAt === "number" && Number.isFinite(maybe.fetchedAt)
      ? maybe.fetchedAt
      : null;
  const limit =
    typeof maybe.limit === "number" && Number.isFinite(maybe.limit) && maybe.limit > 0
      ? maybe.limit
      : null;
  const newest =
    maybe.newest === null
      ? null
      : typeof maybe.newest === "number" && Number.isFinite(maybe.newest)
        ? maybe.newest
        : null;

  if (fetchedAt === null || limit === null) {
    return null;
  }

  return {
    fetchedAt,
    limit,
    newest,
    rangeType: "latest",
  };
}
