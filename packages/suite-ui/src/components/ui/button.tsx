// Adapted from shadcn/ui (MIT), new-york-v4 registry. See THIRD_PARTY_NOTICES.md.
"use client";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-base font-medium whitespace-nowrap transition-[background-color,border-color,box-shadow]     disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive   [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90   ",
        outline: "border bg-surface hover:bg-surface-2 border-input  ",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-surface-2",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-(--control-h) px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--control-h-sm) gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-(--control-h) p-0",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-(--control-h-sm) p-0",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      {...props}
      type={asChild ? undefined : type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
    />
  );
}

export { Button, buttonVariants };
