import type { UTCTimestamp } from "lightweight-charts";

export type Point = {
  time: UTCTimestamp;
  price: number;
};

export type DrawingType = "trendline" | "rectangle" | "text";
export type LineExtension = "none" | "right" | "both";

export type Trendline = {
  id: string;
  start: Point;
  end: Point;
  extend: LineExtension;
};

export type Rectangle = {
  id: string;
  start: Point;
  end: Point;
};

export type TextDrawing = {
  id: string;
  time: UTCTimestamp;
  price: number;
  text: string;
};

export type Drawing = Trendline | Rectangle | TextDrawing;

export type DrawingSelection = {
  id: string;
  type: DrawingType;
};

export type ChartDrawings = {
  trendlines: Trendline[];
  rectangles: Rectangle[];
  texts: TextDrawing[];
};

export type DrawingsState = Record<string, ChartDrawings>;

export const EMPTY_CHART_DRAWINGS: ChartDrawings = {
  trendlines: [],
  rectangles: [],
  texts: [],
};

export const DEFAULT_TRENDLINE_EXTENSION: LineExtension = "right";

export function createDrawingId(type: DrawingType): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${type}_${crypto.randomUUID()}`;
  }

  return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
