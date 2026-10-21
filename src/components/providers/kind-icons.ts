import {
  Asterisk,
  Infinity as InfinityIcon,
  MessageCircle,
  Moon,
  Orbit,
  Plug,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

const KIND_ICONS: Record<string, LucideIcon> = {
  openai: Sparkles,
  anthropic: Asterisk,
  openrouter: Route,
  openrouter_eu: Route,
  xai: Zap,
  typesafe: ShieldCheck,
  openai_compat: Server,
  codex: MessageCircle,
  grok_build: Zap,
  claude: Asterisk,
  antigravity: Orbit,
  moonshot: Moon,
  moonshot_cn: Moon,
  kimi: Moon,
  kimi_ai: Moon,
  meta: InfinityIcon,
  muse_code: InfinityIcon,
};

export function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? Plug;
}
