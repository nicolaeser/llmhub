import type { LucideIcon } from "lucide-react";
import type { Tone } from "@/types/console";

const TONES: Record<Tone, string> = {
  accent: "bg-accent/12 text-accent",
  success: "bg-success/12 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-danger/12 text-danger",
  neutral: "bg-foreground/6 text-muted",
};

const SIZES = {
  sm: { box: "size-7 rounded-md", icon: 14 },
  md: { box: "size-9 rounded-lg", icon: 16 },
  lg: { box: "size-12 rounded-xl", icon: 20 },
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
    <span className={`grid shrink-0 place-items-center ${box} ${TONES[tone]}`} aria-hidden>
      <Icon size={icon} />
    </span>
  );
}
