"use client";

import { Fragment } from "react";
import {
  Alert,
  Card,
  Disclosure,
  Separator,
  Spinner,
  buttonVariants,
} from "@heroui/react";
import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  Building2,
  ChartColumn,
  ChartPie,
  CircleAlert,
  CircleCheck,
  CirclePlus,
  CircleSlash,
  KeyRound,
  ListChecks,
  Network,
  PencilLine,
  Plug,
  ScrollText,
  Settings,
  Trash2,
  UserCog,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { assistantToolCatalog, assistantToolNames } from "@/lib/assistant/catalog";
import { toolArgsPreview, toolErrorCode } from "@/lib/assistant/transcript";
import type {
  AssistantToolAccess,
  AssistantToolGroup,
  AssistantToolName,
  AssistantToolPart,
} from "@/types/assistant";
import { NAV } from "@/app/(app)/_components/nav-data";
import CopyButton from "@/components/console/copy-button";

const NAMED_ICONS: Partial<Record<AssistantToolName, LucideIcon>> = {
  get_setup_status: ListChecks,
  search_logs: ScrollText,
  search_audit_log: ScrollText,
  usage_breakdown: ChartPie,
  explain: BookOpen,
  open_page: ArrowUpRight,
  list_provider_kinds: Boxes,
  create_provider: CirclePlus,
  create_model: CirclePlus,
  create_key: CirclePlus,
};

const GROUP_ICONS: Record<AssistantToolGroup, LucideIcon> = {
  general: BookOpen,
  usage: ChartColumn,
  providers: Plug,
  models: Network,
  keys: KeyRound,
  structure: Building2,
  access: UserCog,
  settings: Settings,
};

const ACCESS_ICONS: Partial<Record<AssistantToolAccess, LucideIcon>> = {
  write: PencilLine,
  destructive: Trash2,
};

const TOOL_ICONS: Partial<Record<string, LucideIcon>> = Object.fromEntries(
  assistantToolNames.map((name) => {
    const { access, group } = assistantToolCatalog[name];
    return [name, NAMED_ICONS[name] ?? ACCESS_ICONS[access] ?? GROUP_ICONS[group]];
  }),
);

const NAV_LABELS = new Map(
  NAV.flatMap((section) => section.items).map((item) => [
    item.href,
    item.labelKey,
  ]),
);

function ToolStatus({ tool }: { tool: AssistantToolPart }) {
  const t = useTranslations("Assistant");
  if (tool.status === "running") {
    return (
      <>
        <Spinner size="sm" color="current" />
        {t("toolStatus", { status: tool.status })}
      </>
    );
  }
  if (tool.status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-danger">
        <CircleAlert size={14} aria-hidden />
        {t("toolError", { code: toolErrorCode(tool.result) })}
      </span>
    );
  }
  if (tool.status === "stopped") {
    return (
      <>
        <CircleSlash size={14} aria-hidden />
        {t("toolStatus", { status: tool.status })}
      </>
    );
  }
  return (
    <>
      <CircleCheck size={14} aria-hidden className="text-success" />
      {Array.isArray(tool.result)
        ? t("toolCount", { count: tool.result.length })
        : t("toolStatus", { status: tool.status })}
    </>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <pre className="max-h-72 overflow-x-auto overflow-y-auto rounded-lg bg-default p-3 font-mono text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function ToolCall({ tool }: { tool: AssistantToolPart }) {
  const t = useTranslations("Assistant");
  const tNav = useTranslations("Sidebar");
  const Icon = TOOL_ICONS[tool.name] ?? Wrench;
  const preview = toolArgsPreview(tool.args);
  const navKey = tool.href ? NAV_LABELS.get(tool.href) : undefined;
  const page = navKey ? tNav(navKey) : (tool.href ?? "");
  const hasArgs = Object.keys(tool.args).length > 0;

  return (
    <Disclosure>
      <Disclosure.Heading level={3}>
        <Disclosure.Trigger className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2.5 text-left text-sm">
          <Icon size={14} aria-hidden className="shrink-0 text-muted" />
          <span className="font-medium text-foreground">
            {t("toolName", { name: tool.name })}
          </span>
          {preview ? (
            <span className="min-w-0 font-mono text-xs break-all text-muted">
              {preview}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <ToolStatus tool={tool} />
            </span>
            <Disclosure.Indicator className="shrink-0" />
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      {tool.href || tool.secret ? (
        <div className="flex flex-col items-start gap-2 px-3 pb-3">
          {tool.href ? (
            <Link
              href={tool.href}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              <ArrowUpRight size={14} aria-hidden />
              {t("openPage", { page })}
            </Link>
          ) : null}
          {tool.secret ? (
            <Alert status="warning" className="w-full">
              <Alert.Content className="min-w-0 gap-1.5">
                <Alert.Description>{t("secretOnce")}</Alert.Description>
                <div className="flex min-w-0 items-start gap-2">
                  <code className="min-w-0 flex-1 font-mono text-xs break-all">
                    {tool.secret}
                  </code>
                  <CopyButton
                    text={tool.secret}
                    label={t("copySecret")}
                    variant="secondary"
                  />
                </div>
              </Alert.Content>
            </Alert>
          ) : null}
        </div>
      ) : null}
      <Disclosure.Content>
        <Disclosure.Body className="flex flex-col gap-3 px-3 pb-3">
          {hasArgs ? <JsonBlock label={t("toolInput")} value={tool.args} /> : null}
          {tool.result !== undefined ? (
            <JsonBlock label={t("toolOutput")} value={tool.result} />
          ) : (
            <p className="text-xs text-muted">
              {t("toolNoOutput", { status: tool.status })}
            </p>
          )}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

export default function ToolCalls({ tools }: { tools: AssistantToolPart[] }) {
  return (
    <Card variant="secondary" className="gap-0 p-0">
      {tools.map((tool, index) => (
        <Fragment key={tool.id}>
          {index > 0 ? <Separator /> : null}
          <ToolCall tool={tool} />
        </Fragment>
      ))}
    </Card>
  );
}
