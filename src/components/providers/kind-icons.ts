import {
  Asterisk,
  Bot,
  MessageCircle,
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
  devin: Bot,
};

export function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? Plug;
}
