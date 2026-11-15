import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-normal transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border border-primary bg-[color-mix(in_oklab,var(--primary)_80%,black)] text-foreground2 hover:bg-[color-mix(in_oklab,var(--primary)_92%,black)]",
        destructive:
          "border border-destructive/60 bg-destructive/15 text-destructive hover:bg-destructive/25",
        outline:
          "border border-edge bg-slate2 text-foreground2/90 hover:bg-slate3",
        secondary:
          "bg-slate3 text-foreground2 hover:bg-slate4",
        ghost:
          "text-foreground hover:bg-slate3 hover:text-foreground2",
        link: "text-foreground underline decoration-primary/50 underline-offset-4 hover:text-foreground2 hover:decoration-primary",
      },
      size: {
        "default": "h-10 px-4 py-2 has-[>svg]:px-3.5",
        "xs": "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        "sm": "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        "lg": "h-10 rounded-md px-6 has-[>svg]:px-4",
        "icon": "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
