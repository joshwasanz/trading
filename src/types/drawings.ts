import type { UTCTimestamp } from "lightweight-charts";

export type Point = {
  time: UTCTimestamp;
  price: number;
};

export type Trendline = {
  start: Point;
  end: Point;
};

export type Rectangle = {
  start: Point;
  end: Point;
};

export type ChartDrawings = {
  trendlines: Trendline[];
  rectangles: Rectangle[];
};

export type DrawingsState = Record<string, ChartDrawings>;

export const EMPTY_CHART_DRAWINGS: ChartDrawings = {
  trendlines: [],
  rectangles: [],
};
