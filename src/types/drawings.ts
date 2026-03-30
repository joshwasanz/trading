import type { UTCTimestamp } from "lightweight-charts";

export type Point = {
  time: UTCTimestamp;
  price: number;
};

export type DrawingType = "trendline" | "rectangle" | "text";
export type LineExtension = "none" | "right" | "both";

export type BaseStyle = {
  color?: string;
  width?: number;
  opacity?: number;
};

export type Trendline = {
  type: "trendline";
  id: string;
  start: Point;
  end: Point;
  extend: LineExtension;
} & BaseStyle;

export type Rectangle = {
  type: "rectangle";
  id: string;
  start: Point;
  end: Point;
} & BaseStyle;

export type TextDrawing = {
  type: "text";
  id: string;
  time: UTCTimestamp;
  price: number;
  text: string;
} & BaseStyle;

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

export function isTrendlineDrawing(drawing: Drawing): drawing is Trendline {
  return drawing.type === "trendline";
}

export function isRectangleDrawing(drawing: Drawing): drawing is Rectangle {
  return drawing.type === "rectangle";
}

export function isTextDrawing(drawing: Drawing): drawing is TextDrawing {
  return drawing.type === "text";
}

export function isPointDrawing(drawing: Drawing): drawing is Trendline | Rectangle {
  return isTrendlineDrawing(drawing) || isRectangleDrawing(drawing);
}
