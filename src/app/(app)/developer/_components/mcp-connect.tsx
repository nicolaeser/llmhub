"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Alert, buttonVariants, Card, Disclosure, DisclosureGroup, RadioGroup, Separator } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { useOrigin } from "@/lib/hooks/use-origin";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import type { ConnectGuideData } from "@/types/api-ref";
import { KEY_CHECK_CODES, KEY_PLACEHOLDER, type ConnectShell, type GuideCode } from "./connect-guides";
import { CodeBlock, KeyField, Section, ShellTabs, StepItem, ToolCard, useDetectedShell, ValueRow } from "./connect-parts";
import { MCP_TOOLS, MCP_TOOLS_LIST, mcpGuide, mcpTool, mcpUrls, type McpStep } from "./mcp-guides";
import { useStoredKey } from "./stored-key";

const MCP_HELP_TOPICS = ["key", "endpoint", "noTools", "sse", "twice", "network", "home"] as const;

const SHARED_HELP_TOPICS = new Set<string>(["key", "home"]);

type McpCheck = { key: string } & ({ ok: true; tools: number } | { ok: false; code: string });

async function checkMcpKey(key: string, url: string): Promise<McpCheck> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(MCP_TOOLS_LIST),
    });
    const body = (await res.json().catch(() => null)) as {
      result?: { tools?: unknown };
      error?: { code?: unknown };
    } | null;
    const tools = body?.result?.tools;
    if (res.ok && Array.isArray(tools)) return { key, ok: true, tools: tools.length };
    const code = typeof body?.error?.code === "string" ? body.error.code : "";
    return { key, ok: false, code: KEY_CHECK_CODES.find((known) => known === code) ?? "other" };
  } catch {
    return { key, ok: false, code: "network" };
  }
}

function checkStatus(check: McpCheck): "success" | "warning" | "danger" {
  if (!check.ok) return "danger";
  return check.tools ? "success" : "warning";
}

export default function McpConnect({ data, canSeeMcp }: { data: ConnectGuideData; canSeeMcp: boolean }) {
  const t = useTranslations("Connect");
  const tCommon = useTranslations("Common");
  const origin = useOrigin();
  const tool = mcpTool(useSearchParam("tool"));
  const detectedShell = useDetectedShell();
  const [shellChoice, setShellChoice] = useState<ConnectShell | null>(null);
  const [apiKey, setApiKey] = useStoredKey(false);
  const [check, setCheck] = useState<McpCheck | null>(null);
  const [checking, startCheck] = useTransition();

  const shell = shellChoice ?? detectedShell;
  const urls = mcpUrls(origin);
  const key = apiKey.trim();
  const currentCheck = check && check.key === key ? check : null;
  const guide = mcpGuide(tool.id, { origin, key: key || KEY_PLACEHOLDER, shell });
  const toolName = t(`mcp.tools.${tool.id}.name`);
  const manage = canSeeMcp ? "yes" : "no";

  const rich = {
    b: (chunks: ReactNode) => <span className="font-semibold text-foreground">{chunks}</span>,
    code: (chunks: ReactNode) => <code className="rounded bg-foreground/5 px-1 font-mono text-xs break-words">{chunks}</code>,
    keys: (chunks: ReactNode) => (
      <Link href="/keys" className="text-accent">
        {chunks}
      </Link>
    ),
    mcp: (chunks: ReactNode) => (
      <Link href="/mcp" className="text-accent">
        {chunks}
      </Link>
    ),
  };

  function runCheck() {
    if (!key || checking) return;
    startCheck(async () => {
      setCheck(await checkMcpKey(key, urls.endpoint));
    });
  }

  function stepText(step: McpStep) {
    if (step.id === "check") return t("mcp.check");
    return t.rich(`mcp.tools.${tool.id}.steps.${step.id}`, rich);
  }

  function codeBlock(code: GuideCode) {
    return (
      <>
        <CodeBlock code={code} copyLabel={tCommon("copy")} downloadLabel={t("setup.download")} />
        {code.text.includes(KEY_PLACEHOLDER) ? (
          <p className="text-xs text-muted">{t("setup.replaceKey", { placeholder: KEY_PLACEHOLDER })}</p>
        ) : null}
      </>
    );
  }

  const createKeyLink = data.canCreateKey ? (
    <Link href="/keys" className={buttonVariants({ size: "sm", variant: "secondary" })}>
      <KeyRound size={14} aria-hidden />
      {t("access.createKey")}
    </Link>
  ) : null;

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{t("mcp.intro")}</p>

      <Alert status="accent">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{t("mcp.auto.title")}</Alert.Title>
          <Alert.Description>{t("mcp.auto.body")}</Alert.Description>
        </Alert.Content>
      </Alert>

      <Section number={1} title={t("pick.title")} description={t("mcp.pick")}>
        <RadioGroup
          value={tool.id}
          onChange={(next) => setSearchParams({ tool: mcpTool(next).id })}
          aria-label={t("pick.title")}
        >
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {MCP_TOOLS.map((item) => (
              <ToolCard
                key={item.id}
                id={item.id}
                label={t(`mcp.tools.${item.id}.name`)}
                hint={t(`mcp.tools.${item.id}.hint`)}
                selected={item.id === tool.id}
              />
            ))}
          </div>
        </RadioGroup>
      </Section>

      <Section number={2} title={t("access.title")} description={t("access.description")}>
        <ValueRow label={t("mcp.access.url")} value={urls.endpoint} hint={t("mcp.access.urlHint")} copyLabel={tCommon("copy")} />
        <p className="text-sm text-muted">{t.rich("mcp.access.tools", { ...rich, manage })}</p>

        <Separator />

        {data.keyCount === 0 && !key ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t("access.noKey")}</Alert.Title>
              <Alert.Description>{t("access.noKeyHint", { create: data.canCreateKey ? "yes" : "no" })}</Alert.Description>
            </Alert.Content>
            {createKeyLink}
          </Alert>
        ) : null}

        <div className="space-y-3">
          <KeyField value={apiKey} onChange={setApiKey} checking={checking} onCheck={runCheck} />
          <p className="text-xs text-muted">{t("access.keyHint")}</p>
          {data.keyCount > 0 || key ? createKeyLink : null}
          {currentCheck ? (
            <Alert status={checkStatus(currentCheck)}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t("result.title", { ok: currentCheck.ok ? "yes" : "no" })}</Alert.Title>
                <Alert.Description>
                  {currentCheck.ok ? (
                    <>
                      {t("mcp.result.ok", { count: currentCheck.tools })}
                      {currentCheck.tools ? null : <> {t.rich("mcp.result.none", { ...rich, manage })}</>}
                    </>
                  ) : (
                    t("mcp.result.fail", { code: currentCheck.code })
                  )}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </div>
      </Section>

      <Section
        number={3}
        title={t("setup.title", { tool: toolName })}
        description={t(`mcp.tools.${tool.id}.about`)}
        actions={tool.shell ? <ShellTabs shell={shell} onChange={setShellChoice} /> : undefined}
      >
        <ol className="space-y-6" aria-label={t("setup.title", { tool: toolName })}>
          {guide.steps.map((step, index) => (
            <StepItem key={step.id} index={index}>
              <p className="text-sm text-foreground">{stepText(step)}</p>
              {step.code ? codeBlock(step.code) : null}
              {step.fields ? (
                <Card variant="secondary" className="gap-4">
                  {step.fields.map((field) => (
                    <ValueRow key={field.id} label={t("mcp.fields", { field: field.id })} value={field.value} copyLabel={tCommon("copy")} />
                  ))}
                </Card>
              ) : null}
              {step.fields?.some((field) => field.value.includes(KEY_PLACEHOLDER)) ? (
                <p className="text-xs text-muted">{t("setup.replaceKey", { placeholder: KEY_PLACEHOLDER })}</p>
              ) : null}
            </StepItem>
          ))}
        </ol>

        {guide.notes.length ? (
          <div className="space-y-2">
            <Separator />
            <p className="pt-2 text-sm font-medium">{t("setup.notes")}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {guide.notes.map((note) => (
                <li key={note.id}>
                  {note.id === "persist"
                    ? t("persist", { shell })
                    : t.rich(`mcp.tools.${tool.id}.notes.${note.id}`, { ...rich, ...note.args })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Card render={(props) => <section {...props} />} aria-label={t("help.title")}>
        <Card.Header>
          <Card.Title>{t("help.title")}</Card.Title>
          <Card.Description>{t("mcp.help")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <DisclosureGroup allowsMultipleExpanded>
            {MCP_HELP_TOPICS.map((topic, index) => {
              const base = SHARED_HELP_TOPICS.has(topic) ? "help.topics" : "mcp.topics";
              return (
                <div key={topic}>
                  {index ? <Separator /> : null}
                  <Disclosure id={topic}>
                    <Disclosure.Heading className="min-w-0">
                      <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-3 py-3 text-left text-sm font-medium">
                        <Disclosure.Indicator />
                        <span className="min-w-0 flex-1 break-words">{t(`${base}.${topic}.title`)}</span>
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <Disclosure.Body className="pb-4 pl-7 text-sm text-muted">
                        {t.rich(`${base}.${topic}.body`, { ...rich, manage })}
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </div>
              );
            })}
          </DisclosureGroup>
        </Card.Content>
      </Card>
    </div>
  );
}
