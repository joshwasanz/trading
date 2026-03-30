// Session configuration for trading day segments
// Data-driven approach for future macro + SMT extensions

export type SessionKey = "asia" | "london" | "newyork";

export interface SessionConfig {
  start: string; // HH:MM format (UTC)
  end: string;   // HH:MM format (UTC)
  color: string; // RGBA for chart overlay
  label: string; // Display name
}

export const SESSION_CONFIG: Record<SessionKey, SessionConfig> = {
  asia: {
    start: "00:00",
    end: "03:00",
    color: "rgba(120, 120, 255, 0.06)",
    label: "Asia",
  },
  london: {
    start: "03:00",
    end: "06:00",
    color: "rgba(77, 163, 255, 0.08)",
    label: "London",
  },
  newyork: {
    start: "09:30",
    end: "12:00",
    color: "rgba(255, 99, 132, 0.08)",
    label: "NY Open",
  },
};

/**
 * Calculate session time range for a specific date
 * Returns UNIX timestamps (seconds)
 */
export function getSessionRange(date: Date, session: SessionKey) {
  const config = SESSION_CONFIG[session];
  const [sh, sm] = config.start.split(":").map(Number);
  const [eh, em] = config.end.split(":").map(Number);

  const startDate = new Date(date);
  startDate.setUTCHours(sh, sm, 0, 0);

  const endDate = new Date(date);
  endDate.setUTCHours(eh, em, 0, 0);

  return {
    start: Math.floor(startDate.getTime() / 1000),
    end: Math.floor(endDate.getTime() / 1000),
  };
}

/**
 * Get all session ranges for a specific date
 */
export function getAllSessions(date: Date) {
  return {
    asia: getSessionRange(date, "asia"),
    london: getSessionRange(date, "london"),
    newyork: getSessionRange(date, "newyork"),
  };
}

/**
 * Determine if a timestamp falls within a session
 */
export function isWithinSession(timestamp: number, session: SessionKey, date: Date): boolean {
  const range = getSessionRange(date, session);
  return timestamp >= range.start && timestamp <= range.end;
}
