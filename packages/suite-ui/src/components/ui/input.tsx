// Adapted from shadcn/ui (MIT), new-york-v4 registry. See THIRD_PARTY_NOTICES.md.
"use client";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-(--control-h) w-full min-w-0 rounded-md border border-input bg-surface px-3 py-1 text-base  transition-[color,box-shadow]  selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-surface file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-base ",
        "focus-visible:border-ring  ",
        "aria-invalid:border-destructive  ",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
