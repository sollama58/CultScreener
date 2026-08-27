import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface DualRangeSliderProps {
  min: number;
  max: number;
  step: number;
  valueMin: number;
  valueMax: number;
  onChange: (next: { min: number; max: number }) => void;
  labelMin: string;
  labelMax: string;
  /** Drives aria-valuetext, so a screen reader announces "1h" rather than the raw number 60. */
  formatValue: (value: number, isUpper: boolean) => string;
}

/**
 * A single-track, two-handle range slider.
 *
 * Deliberately NOT the common trick of stacking two native <input type="range"> elements on top
 * of each other: that approach makes one handle's whole track intercept clicks meant for the
 * other whenever the two values are close together, since a native range input's entire body -
 * not just its thumb - is clickable. That is a real, reproducible bug, not a hypothetical one,
 * and it gets worse the more someone actually uses the slider to narrow a range tightly (exactly
 * when both handles are near each other). Built from scratch instead: each handle is its own
 * small element with its own pointer-capture drag, so only ~16px around each handle intercepts
 * anything, matching what a person actually sees and expects to grab.
 */
export function DualRangeSlider({
  min,
  max,
  step,
  valueMin,
  valueMax,
  onChange,
  labelMin,
  labelMax,
  formatValue,
}: DualRangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Which handle is mid-drag, so a move event for the OTHER handle's (already-released) pointer
  // can't still be acted on - relevant once pointer capture is involved.
  const draggingRef = useRef<"min" | "max" | null>(null);
  // Only affects which handle sits visually on top when they overlap exactly - see the render
  // below. Not read during drag logic itself; pointer capture already routes every subsequent
  // event straight to the handle that was actually pressed, regardless of stacking order.
  const [topHandle, setTopHandle] = useState<"min" | "max">("max");

  const span = max - min;

  const clampToStep = useCallback(
    (raw: number) => {
      const snapped = Math.round((raw - min) / step) * step + min;
      return Math.min(max, Math.max(min, snapped));
    },
    [min, max, step],
  );

  const valueFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return min;
      const rect = track.getBoundingClientRect();
      if (rect.width === 0) return min;
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return clampToStep(min + pct * span);
    },
    [min, span, clampToStep],
  );

  const moveHandle = useCallback(
    (which: "min" | "max", clientX: number) => {
      const raw = valueFromClientX(clientX);
      if (which === "min") {
        onChange({ min: Math.min(raw, valueMax), max: valueMax });
      } else {
        onChange({ min: valueMin, max: Math.max(raw, valueMin) });
      }
    },
    [valueFromClientX, onChange, valueMin, valueMax],
  );

  const startDrag = useCallback(
    (which: "min" | "max") => (e: ReactPointerEvent<HTMLDivElement>) => {
      // Left button / primary touch only - a right-click or auxiliary pointer shouldn't drag it.
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = which;
      setTopHandle(which);
      moveHandle(which, e.clientX);
    },
    [moveHandle],
  );

  const onDrag = useCallback(
    (which: "min" | "max") => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (draggingRef.current !== which) return;
      moveHandle(which, e.clientX);
    },
    [moveHandle],
  );

  const endDrag = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const nudge = useCallback(
    (which: "min" | "max") => (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const big = e.shiftKey ? step * 10 : step;
      let delta = 0;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -big;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = big;
      else if (e.key === "Home") delta = which === "min" ? min - valueMin : valueMin - valueMax;
      else if (e.key === "End") delta = which === "min" ? valueMax - valueMin : max - valueMax;
      else return;
      e.preventDefault();
      if (which === "min") {
        onChange({ min: clampToStep(Math.min(valueMin + delta, valueMax)), max: valueMax });
      } else {
        onChange({ min: valueMin, max: clampToStep(Math.max(valueMax + delta, valueMin)) });
      }
    },
    [step, min, max, valueMin, valueMax, onChange, clampToStep],
  );

  const pctMin = span > 0 ? ((valueMin - min) / span) * 100 : 0;
  const pctMax = span > 0 ? ((valueMax - min) / span) * 100 : 100;

  return (
    <div className="dual-range" ref={trackRef}>
      <div className="dual-range__track" />
      <div className="dual-range__fill" style={{ left: `${pctMin}%`, right: `${100 - pctMax}%` }} />
      <div
        className="dual-range__handle"
        style={{ left: `${pctMin}%`, zIndex: topHandle === "min" ? 2 : 1 }}
        role="slider"
        tabIndex={0}
        aria-label={labelMin}
        aria-valuemin={min}
        aria-valuemax={valueMax}
        aria-valuenow={valueMin}
        aria-valuetext={formatValue(valueMin, false)}
        onPointerDown={startDrag("min")}
        onPointerMove={onDrag("min")}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudge("min")}
      />
      <div
        className="dual-range__handle"
        style={{ left: `${pctMax}%`, zIndex: topHandle === "max" ? 2 : 1 }}
        role="slider"
        tabIndex={0}
        aria-label={labelMax}
        aria-valuemin={valueMin}
        aria-valuemax={max}
        aria-valuenow={valueMax}
        aria-valuetext={formatValue(valueMax, true)}
        onPointerDown={startDrag("max")}
        onPointerMove={onDrag("max")}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudge("max")}
      />
    </div>
  );
}
