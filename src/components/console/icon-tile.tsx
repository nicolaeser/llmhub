import type { LucideIcon } from "lucide-react";
import type { Tone } from "@/types/console";

const TONES: Record<Tone, string> = {
  accent: "bg-accent/12 text-accent ring-accent/20",
  success: "bg-success/12 text-success ring-success/20",
  warning: "bg-warning/14 text-warning ring-warning/25",
  danger: "bg-danger/12 text-danger ring-danger/20",
  neutral: "bg-foreground/6 text-muted ring-foreground/8",
};

const SIZES = {
  sm: { box: "size-7 rounded-lg", icon: 14 },
  md: { box: "size-9 rounded-xl", icon: 16 },
  lg: { box: "size-12 rounded-2xl", icon: 20 },
  xl: { box: "size-14 rounded-2xl", icon: 24 },
} as const;

export default function IconTile({
  icon: Icon,
  tone = "accent",
  size = "md",
}: {
  icon: LucideIcon;
  tone?: Tone;
  size?: keyof typeof SIZES;
}) {
  const { box, icon } = SIZES[size];
  return (
    <span className={`grid shrink-0 place-items-center ring-1 ring-inset ${box} ${TONES[tone]}`} aria-hidden>
      <Icon size={icon} />
    </span>
  );
}
