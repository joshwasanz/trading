import type { Drawing } from "../types/drawings";

type Props = {
  drawing: Drawing | null;
  onUpdate: (patch: Partial<Drawing>) => void;
};

export default function DrawingStylePanel({ drawing, onUpdate }: Props) {
  if (!drawing) return null;

  const color = drawing.color || "#4da3ff";
  const width = drawing.width || 2;
  const opacity = drawing.opacity ?? 1;

  return (
    <div className="drawing-style-panel" onClick={(e) => e.stopPropagation()}>
      <div className="style-panel__title">Style</div>

      {/* Color Picker */}
      <div className="style-panel__group">
        <label>Color</label>
        <div className="style-panel__row">
          <input
            type="color"
            value={color}
            onChange={(e) => onUpdate({ color: e.target.value })}
            style={{ width: "100%", height: "32px", cursor: "pointer" }}
          />
        </div>
      </div>

      {/* Width Slider */}
      <div className="style-panel__group">
        <label>Width: {width}px</label>
        <div className="style-panel__row">
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={width}
            onChange={(e) => onUpdate({ width: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </div>
      </div>

      {/* Opacity Slider */}
      <div className="style-panel__group">
        <label>Opacity: {Math.round(opacity * 100)}%</label>
        <div className="style-panel__row">
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.1}
            value={opacity}
            onChange={(e) => onUpdate({ opacity: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}
