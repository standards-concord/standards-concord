"use client";
import type { ComponentProps, KeyboardEvent, SyntheticEvent } from "react";
import { Button } from "./button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

export type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "aria-labelledby" | "asChild" | "size"
> & {
  label: string;
  size?: "icon" | "icon-sm";
  "data-slot"?: string;
};

function preventActivation(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function preventKeyboardActivation(event: KeyboardEvent) {
  // Keep Tab navigation and Escape tooltip dismissal available.
  if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) preventActivation(event);
}

/** The label is shared by the accessible name and the hover/focus tooltip. */
export function IconButton({
  label,
  size = "icon",
  disabled,
  children,
  "data-slot": dataSlot = "button",
  ...props
}: IconButtonProps) {
  if (!label.trim()) throw new Error("IconButton requires a non-empty label");
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            {...props}
            asChild
            size={size}
            aria-label={label}
            aria-disabled={disabled || undefined}
            onClick={disabled ? preventActivation : props.onClick}
            onDoubleClick={disabled ? preventActivation : props.onDoubleClick}
            onKeyDown={disabled ? preventKeyboardActivation : props.onKeyDown}
            onKeyUp={disabled ? preventKeyboardActivation : props.onKeyUp}
            onPointerDown={disabled ? preventActivation : props.onPointerDown}
            onPointerUp={disabled ? preventActivation : props.onPointerUp}
            onMouseDown={disabled ? preventActivation : props.onMouseDown}
            onMouseUp={disabled ? preventActivation : props.onMouseUp}
          >
            {/* Slot preserves shell/navigation slots without changing Button's default slot. */}
            <button type={props.type ?? "button"} data-slot={dataSlot}>
              {children}
            </button>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
