"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

type ResizeHandleProps = {
  orientation: "horizontal" | "vertical";
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
  className?: string;
};

type DragState = {
  pointerId: number;
  startPosition: number;
  startValue: number;
};

const KEYBOARD_STEP = 16;

export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  label,
  onChange,
  className,
}: ResizeHandleProps) {
  const dragRef = useRef<DragState | null>(null);

  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const position = (event: PointerEvent<HTMLDivElement>) =>
    orientation === "vertical" ? event.clientX : event.clientY;

  function finishDrag() {
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startPosition: position(event),
      startValue: value,
    };
    document.body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = position(event) - drag.startPosition;
    onChange(clamp(drag.startValue + (orientation === "vertical" ? delta : -delta)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (event.key === "Home") next = min;
    if (event.key === "End") next = max;
    if (orientation === "vertical") {
      if (event.key === "ArrowLeft") next = value - KEYBOARD_STEP;
      if (event.key === "ArrowRight") next = value + KEYBOARD_STEP;
    } else {
      if (event.key === "ArrowUp") next = value + KEYBOARD_STEP;
      if (event.key === "ArrowDown") next = value - KEYBOARD_STEP;
    }
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className={cn(
        "group absolute z-30 touch-none outline-none",
        orientation === "vertical"
          ? "inset-y-0 -right-1 w-2 cursor-col-resize"
          : "inset-x-0 -top-1 h-2 cursor-row-resize",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={handleKeyDown}
    >
      <span
        className={cn(
          "absolute bg-transparent transition-colors group-hover:bg-ring/70 group-focus-visible:bg-ring",
          orientation === "vertical"
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
