export type SessionKey = "asia" | "london" | "newyork";

export interface SessionConfig {
  startHour: number;
  endHour: number;
  color: string;
  activeColor: string;
  rangeColor: string;
  activeRangeColor: string;
  levelColor: string;
  activeLevelColor: string;
  label: string;
}

export interface SessionRange {
  type: SessionKey;
  start: number;
  end: number;
}

export interface SessionStats {
  type: SessionKey;
  start: number;
  end: number;
  high: number;
  low: number;
}

export const SESSION_KEYS: SessionKey[] = ["asia", "london", "newyork"];

export const SESSION_CONFIG: Record<SessionKey, SessionConfig> = {
  asia: {
    startHour: 0,
    endHour: 8,
    color: "rgba(99, 102, 241, 0.07)",
    activeColor: "rgba(99, 102, 241, 0.14)",
    rangeColor: "rgba(99, 102, 241, 0.08)",
    activeRangeColor: "rgba(99, 102, 241, 0.14)",
    levelColor: "rgba(129, 140, 248, 0.34)",
    activeLevelColor: "rgba(129, 140, 248, 0.5)",
    label: "Asia",
  },
  london: {
    startHour: 8,
    endHour: 13,
    color: "rgba(245, 158, 11, 0.06)",
    activeColor: "rgba(245, 158, 11, 0.14)",
    rangeColor: "rgba(245, 158, 11, 0.08)",
    activeRangeColor: "rgba(245, 158, 11, 0.14)",
    levelColor: "rgba(251, 191, 36, 0.34)",
    activeLevelColor: "rgba(251, 191, 36, 0.5)",
    label: "London",
  },
  newyork: {
    startHour: 13,
    endHour: 21,
    color: "rgba(239, 68, 68, 0.07)",
    activeColor: "rgba(239, 68, 68, 0.14)",
    rangeColor: "rgba(239, 68, 68, 0.08)",
    activeRangeColor: "rgba(239, 68, 68, 0.14)",
    levelColor: "rgba(248, 113, 113, 0.34)",
    activeLevelColor: "rgba(248, 113, 113, 0.5)",
    label: "New York",
  },
};

function getUtcDayStartTimestamp(value: Date | number): number {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function getSessionRange(value: Date | number, session: SessionKey): SessionRange {
  const config = SESSION_CONFIG[session];
  const dayStart = getUtcDayStartTimestamp(value);

  return {
    type: session,
    start: dayStart + config.startHour * 3600,
    end: dayStart + config.endHour * 3600,
  };
}

export function getSessionForTimestamp(timestamp: number): SessionKey | null {
  for (const session of SESSION_KEYS) {
    const range = getSessionRange(timestamp, session);
    if (timestamp >= range.start && timestamp < range.end) {
      return session;
    }
  }

  return null;
}

export function getSessionLabel(session: SessionKey | null): string {
  return session ? SESSION_CONFIG[session].label : "Off Hours";
}

export function buildSessionRanges(candles: Array<{ time: number }>): SessionRange[] {
  if (candles.length === 0) {
    return [];
  }

  const rangeStart = candles[0]?.time;
  const rangeEnd = candles[candles.length - 1]?.time;

  if (typeof rangeStart !== "number" || typeof rangeEnd !== "number") {
    return [];
  }

  const ranges: SessionRange[] = [];
  const startDay = new Date(rangeStart * 1000);
  const endDay = new Date(rangeEnd * 1000);
  startDay.setUTCHours(0, 0, 0, 0);
  endDay.setUTCHours(0, 0, 0, 0);

  for (
    const day = new Date(startDay);
    day.getTime() <= endDay.getTime();
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    for (const session of SESSION_KEYS) {
      const range = getSessionRange(day, session);
      const clippedStart = Math.max(range.start, rangeStart);
      const clippedEnd = Math.min(range.end, rangeEnd);

      if (clippedEnd <= clippedStart) {
        continue;
      }

      ranges.push({
        type: session,
        start: clippedStart,
        end: clippedEnd,
      });
    }
  }

  return ranges;
}

export function buildSessionStats(
  candles: Array<{ time: number; high: number; low: number }>
): SessionStats[] {
  if (candles.length === 0) {
    return [];
  }

  const stats: SessionStats[] = [];
  let current: SessionStats | null = null;
  let currentWindowStart: number | null = null;

  for (const candle of candles) {
    const session = getSessionForTimestamp(candle.time);

    if (session === null) {
      if (current) {
        stats.push(current);
        current = null;
        currentWindowStart = null;
      }
      continue;
    }

    const sessionRange = getSessionRange(candle.time, session);
    const sameSession =
      current !== null &&
      current.type === session &&
      currentWindowStart === sessionRange.start;

    if (!sameSession) {
      if (current) {
        stats.push(current);
      }

      current = {
        type: session,
        start: candle.time,
        end: candle.time,
        high: candle.high,
        low: candle.low,
      };
      currentWindowStart = sessionRange.start;
      continue;
    }

    const currentSession = current;
    if (!currentSession) {
      continue;
    }

    currentSession.end = candle.time;
    currentSession.high = Math.max(currentSession.high, candle.high);
    currentSession.low = Math.min(currentSession.low, candle.low);
  }

  if (current) {
    stats.push(current);
  }

  return stats;
}
