import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

export const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-l-full rounded-r-none py-[2px] pl-2 pr-3 text-[10px] leading-none font-bold w-fit whitespace-nowrap shrink-0 [&>svg]:size-2.5 gap-1.5 [&>svg]:pointer-events-none [clip-path:polygon(0_0,100%_0,calc(100%-5px)_100%,0_100%)] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "bg-[#6f5fc4] text-white",
        secondary:
          "bg-slate3 text-foreground2",
        destructive:
          "bg-[#9f0712] text-white",
        outline:
          "bg-[#47484a] text-foreground2",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
