import type { LucideIcon, LucideProps } from "lucide-react";

export type IconProps = LucideProps & { icon: LucideIcon };

/** A lucide glyph at the shared size and stroke. Decorative unless given a label. */
export function Icon({ icon: Glyph, size = 16, strokeWidth = 1.75, ...props }: IconProps) {
  return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
}
