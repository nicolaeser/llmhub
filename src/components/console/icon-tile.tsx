import type { LucideIcon } from "lucide-react";
import type { Tone } from "@/types/console";

const TONES: Record<Tone, string> = {
  accent: "bg-accent/10 text-accent ring-accent/15",
  success: "bg-success/10 text-success ring-success/15",
  warning: "bg-warning/12 text-warning ring-warning/20",
  danger: "bg-danger/10 text-danger ring-danger/15",
  neutral: "bg-foreground/5 text-muted ring-foreground/8",
};

const SIZES = {
  sm: { box: "size-7 rounded-xl", icon: 14 },
  md: { box: "size-8 rounded-2xl", icon: 16 },
  lg: { box: "size-10 rounded-2xl", icon: 20 },
  xl: { box: "size-12 rounded-3xl", icon: 24 },
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
