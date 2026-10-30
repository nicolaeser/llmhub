"use client";

import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import {
  Alert,
  Button,
  buttonVariants,
  Card,
  Disclosure,
  DisclosureGroup,
  Input,
  Label,
  Radio,
  RadioGroup,
  Separator,
  Spinner,
  Surface,
  Tabs,
  TextField,
} from "@heroui/react";
import { AppWindow, Braces, Download, KeyRound, Plug, SquareTerminal, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import ChoiceCards from "@/components/console/choice-cards";
import CopyButton from "@/components/console/copy-button";
import PageStatus from "@/components/console/page-status";
import SearchSelect from "@/components/console/search-select";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useOrigin } from "@/lib/hooks/use-origin";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import type { ConnectRoute } from "@/types/api-ref";
import { loadConnectGuideAction } from "../_action";
import {
  CONNECT_GROUPS,
  chatFirst,
  CONNECT_TOOLS,
  connectTool,
  gatewayUrls,
  isLocalOrigin,
  KEY_PLACEHOLDER,
  MODEL_PLACEHOLDER,
  routeModels,
  toolGuide,
  toolProtocol,
  type ConnectGroup,
  type ConnectSdk,
  type ConnectShell,
  type ConnectTool,
  type GuideCode,
  type GuideStep,
} from "./connect-guides";
import { useStoredKey } from "./stored-key";

const GROUP_ICONS: Record<ConnectGroup, LucideIcon> = {
  coding: SquareTerminal,
  apps: AppWindow,
  code: Braces,
  other: Plug,
};

const CHECK_CODES = [
  "invalid_api_key",
  "key_paused",
  "ip_not_allowed",
  "outside_access_window",
  "endpoint_not_allowed",
  "budget_exceeded",
  "rate_limit_exceeded",
] as const;

const HELP_TOPICS = ["key", "url", "model", "subscription", "limit", "blocked", "network", "models", "home", "logs"] as const;

type KeyCheck = { key: string; route: ConnectRoute } & ({ ok: true; models: string[] } | { ok: false; code: string });

const noSubscription = () => () => {};

function detectShell(): ConnectShell {
  return /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
}

function downloadJson(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function checkKey(key: string, route: ConnectRoute, url: string): Promise<KeyCheck> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const body = (await res.json().catch(() => null)) as {
      data?: { id?: unknown }[];
      error?: { code?: unknown };
    } | null;
    if (res.ok) {
      const models = (body?.data ?? []).map((entry) => String(entry.id ?? "")).filter(Boolean);
      return { key, route, ok: true, models };
    }
    const code = typeof body?.error?.code === "string" ? body.error.code : "";
    return { key, route, ok: false, code: CHECK_CODES.find((known) => known === code) ?? "other" };
  } catch {
    return { key, route, ok: false, code: "network" };
  }
}

function Section({
  number,
  title,
  description,
  actions,
  children,
}: {
  number: number;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card render={(props) => <section {...props} />} aria-label={title} className="gap-5">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <span
            className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-foreground tabular-nums"
            aria-hidden
          >
            {number}
          </span>
          <div className="min-w-0">
            <Card.Title>{title}</Card.Title>
            {description ? <Card.Description>{description}</Card.Description> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </Card.Header>
      <Card.Content className="space-y-5">{children}</Card.Content>
    </Card>
  );
}

function CodeBlock({ code, copyLabel, downloadLabel }: { code: GuideCode; copyLabel: string; downloadLabel: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {code.file ? <code className="font-mono text-xs text-muted break-words">{code.file}</code> : <span />}
        <div className="flex flex-wrap gap-2">
          {code.download ? (
            <Button size="sm" variant="secondary" onPress={() => downloadJson(code.download!, code.text)}>
              <Download size={14} aria-hidden />
              {downloadLabel}
            </Button>
          ) : null}
          <CopyButton text={code.text} label={copyLabel} variant="secondary" showLabel />
        </div>
      </div>
      <Surface variant="secondary" className="overflow-x-auto rounded-xl p-4">
        <pre className="font-mono text-xs whitespace-pre-wrap break-words">{code.text}</pre>
      </Surface>
    </div>
  );
}

function ValueRow({ label, value, hint, copyLabel }: { label: string; value: string; hint?: string; copyLabel: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-medium">{label}</p>
        <code className="mt-1 block font-mono text-sm break-all">{value}</code>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </div>
      <CopyButton text={value} label={copyLabel} variant="secondary" showLabel />
    </div>
  );
}

export default function ConnectTab() {
  const t = useTranslations("Connect");
  const tCommon = useTranslations("Common");
  const origin = useOrigin();
  const page = useActionData(loadConnectGuideAction);
  const tool = connectTool(useSearchParam("tool"));
  const detectedShell = useSyncExternalStore(noSubscription, detectShell, () => "posix" as const);
  const [shellChoice, setShellChoice] = useState<ConnectShell | null>(null);
  const [sdk, setSdk] = useState<ConnectSdk>("openai");
  const [routeChoice, setRouteChoice] = useState<{ tool: ConnectTool; route: ConnectRoute } | null>(null);
  const [apiKey, setApiKey] = useStoredKey(false);
  const [modelChoice, setModelChoice] = useState("");
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [checking, startCheck] = useTransition();

  if (!page.data) return <PageStatus state={page} layout="panels" />;

  const data = page.data;
  const hasSubscriptions = data.models.subscription.length > 0;
  const route: ConnectRoute = !hasSubscriptions
    ? "api"
    : routeChoice?.tool === tool.id
      ? routeChoice.route
      : tool.route;
  const shell = shellChoice ?? detectedShell;
  const protocol = toolProtocol(tool, sdk);
  const urls = gatewayUrls(origin, route);
  const key = apiKey.trim();
  const currentCheck = check && check.key === key && check.route === route ? check : null;
  const models = currentCheck?.ok ? chatFirst(currentCheck.models, data.models) : routeModels(data.models, route);
  const model = models.includes(modelChoice) ? modelChoice : (models[0] ?? MODEL_PLACEHOLDER);
  const guide = toolGuide(tool.id, { origin, route, key: key || KEY_PLACEHOLDER, model, shell, sdk });
  const toolName = t(`tools.${tool.id}.name`);
  const local = origin && isLocalOrigin(origin) ? new URL(origin).host : null;

  const rich = {
    b: (chunks: ReactNode) => <span className="font-semibold text-foreground">{chunks}</span>,
    code: (chunks: ReactNode) => <code className="rounded bg-foreground/5 px-1 font-mono text-xs">{chunks}</code>,
    logs: (chunks: ReactNode) => (
      <Link href="/logs" className="text-accent">
        {chunks}
      </Link>
    ),
    keys: (chunks: ReactNode) => (
      <Link href="/keys" className="text-accent">
        {chunks}
      </Link>
    ),
  };
  const withLogs = data.canSeeLogs ? "yes" : "no";
  const filled = key ? "yes" : "no";

  function runCheck() {
    if (!key || checking) return;
    startCheck(async () => {
      setCheck(await checkKey(key, route, urls.models));
    });
  }

  function stepText(step: GuideStep) {
    if (step.id === "check") return t.rich("check", { ...rich, withLogs });
    return t.rich(`tools.${tool.id}.steps.${step.id}`, {
      ...rich,
      ...step.args,
      model,
      filled,
      shell,
      sdk,
      route,
      key: KEY_PLACEHOLDER,
    });
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

  const switches = (
    <>
      {tool.protocol === "choice" ? (
        <Tabs selectedKey={sdk} onSelectionChange={(next) => setSdk(next === "anthropic" ? "anthropic" : "openai")} className="w-fit">
          <Tabs.List className="w-fit min-w-0" aria-label={t("setup.sdk")}>
            {(["openai", "anthropic"] as const).map((id) => (
              <Tabs.Tab key={id} id={id} className="w-auto">
                {t("setup.sdkName", { sdk: id })}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      ) : null}
      {tool.shell ? (
        <Tabs
          selectedKey={shell}
          onSelectionChange={(next) => setShellChoice(next === "windows" ? "windows" : "posix")}
          className="w-fit"
        >
          <Tabs.List className="w-fit min-w-0" aria-label={t("setup.shell")}>
            {(["posix", "windows"] as const).map((id) => (
              <Tabs.Tab key={id} id={id} className="w-auto">
                {t("setup.shellName", { shell: id })}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      ) : null}
    </>
  );

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{t("intro")}</p>

      {local ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("local.title")}</Alert.Title>
            <Alert.Description>{t("local.body", { host: local })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Section number={1} title={t("pick.title")} description={t("pick.description")}>
        <RadioGroup
          value={tool.id}
          onChange={(next) => setSearchParams({ tool: connectTool(next).id })}
          aria-label={t("pick.title")}
          className="gap-5"
        >
          {CONNECT_GROUPS.map((group) => {
            const Icon = GROUP_ICONS[group];
            return (
              <div key={group} className="space-y-2">
                <p className="flex items-center gap-2 text-xs font-medium text-muted">
                  <Icon size={14} aria-hidden />
                  {t("group", { group })}
                </p>
                <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                  {CONNECT_TOOLS.filter((item) => item.group === group).map((item) => {
                    const selected = item.id === tool.id;
                    return (
                      <Card
                        key={item.id}
                        variant="secondary"
                        className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
                      >
                        <Radio value={item.id} className="mt-0 h-full w-full">
                          <Radio.Content className="h-full w-full items-start gap-3 p-3">
                            <Radio.Control>
                              <Radio.Indicator />
                            </Radio.Control>
                            <span className="min-w-0 flex-1 space-y-1">
                              <Label>{t(`tools.${item.id}.name`)}</Label>
                              <span className="hidden text-xs font-normal text-muted sm:block">{t(`tools.${item.id}.hint`)}</span>
                            </span>
                          </Radio.Content>
                        </Radio>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      </Section>

      <Section number={2} title={t("access.title")} description={t("access.description")}>
        {hasSubscriptions ? (
          <ChoiceCards
            label={t("access.route")}
            value={route}
            columns={2}
            options={(["subscription", "api"] as const).map((id) => ({
              id,
              label: t("access.routeOption", { route: id }),
              hint: t("access.routeHint", { route: id }),
            }))}
            onChange={(next) => setRouteChoice({ tool: tool.id, route: next })}
          />
        ) : null}

        <ValueRow
          label={t("access.url")}
          value={protocol === "anthropic" ? urls.anthropic : urls.openai}
          hint={t("access.urlHint", { protocol })}
          copyLabel={tCommon("copy")}
        />

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
          <div className="flex flex-wrap items-end gap-2">
            <TextField fullWidth value={apiKey} onChange={setApiKey} type="password" className="min-w-0 flex-1 basis-64">
              <Label>{t("access.key")}</Label>
              <Input type="password" autoComplete="off" spellCheck={false} placeholder={KEY_PLACEHOLDER} />
            </TextField>
            <Button variant="secondary" isPending={checking} isDisabled={!key} onPress={runCheck}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("access.check")}
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted">{t("access.keyHint")}</p>
          {data.keyCount > 0 || key ? createKeyLink : null}
          {currentCheck ? (
            <Alert status={currentCheck.ok ? "success" : "danger"}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t("result.title", { ok: currentCheck.ok ? "yes" : "no" })}</Alert.Title>
                <Alert.Description>
                  {currentCheck.ok
                    ? t("result.ok", { count: currentCheck.models.length })
                    : t("result.fail", { code: currentCheck.code })}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </div>

        {tool.needsModel ? (
          <>
            <Separator />
            {models.length ? (
              <SearchSelect
                label={t("access.model")}
                description={t("access.modelHint")}
                items={models.map((id) => ({ id, label: id }))}
                value={model}
                onChange={setModelChoice}
                className="max-w-md"
              />
            ) : (
              <p className="text-sm text-muted">{t("access.noModels")}</p>
            )}
          </>
        ) : null}
      </Section>

      <Section
        number={3}
        title={t("setup.title", { tool: toolName })}
        description={t(`tools.${tool.id}.about`)}
        actions={tool.protocol === "choice" || tool.shell ? switches : undefined}
      >
        <ol className="space-y-6" aria-label={t("setup.title", { tool: toolName })}>
          {guide.steps.map((step, index) => (
            <li key={step.id} className="flex gap-3">
              <span
                className="grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold text-muted tabular-nums ring-1 ring-border ring-inset"
                aria-hidden
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-3">
                <p className="text-sm text-foreground">{stepText(step)}</p>
                {step.code ? codeBlock(step.code) : null}
                {step.fields ? (
                  <Card variant="secondary" className="gap-4">
                    {step.fields.map((field) => (
                      <ValueRow
                        key={field.id}
                        label={t(`tools.${tool.id}.fields.${field.id}`)}
                        value={field.value}
                        copyLabel={tCommon("copy")}
                      />
                    ))}
                  </Card>
                ) : null}
                {step.fields?.some((field) => field.value === KEY_PLACEHOLDER) ? (
                  <p className="text-xs text-muted">{t("setup.replaceKey", { placeholder: KEY_PLACEHOLDER })}</p>
                ) : null}
                {step.alt ? (
                  <>
                    <p className="text-sm text-muted">{t.rich(`tools.${tool.id}.alt.${step.alt.id}`, rich)}</p>
                    {codeBlock(step.alt.code)}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        {guide.notes.length ? (
          <div className="space-y-2">
            <Separator />
            <p className="pt-2 text-sm font-medium">{t("setup.notes")}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {guide.notes.map((note) => (
                <li key={note}>
                  {note === "persist"
                    ? t("persist", { shell })
                    : t.rich(`tools.${tool.id}.notes.${note}`, { ...rich, sdk, route })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Card render={(props) => <section {...props} />} aria-label={t("help.title")}>
        <Card.Header>
          <Card.Title>{t("help.title")}</Card.Title>
          <Card.Description>{t("help.description")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <DisclosureGroup allowsMultipleExpanded>
            {HELP_TOPICS.filter((topic) => topic !== "subscription" || hasSubscriptions).map((topic, index) => (
              <div key={topic}>
                {index ? <Separator /> : null}
                <Disclosure id={topic}>
                  <Disclosure.Heading className="min-w-0">
                    <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-3 py-3 text-left text-sm font-medium">
                      <Disclosure.Indicator />
                      <span className="min-w-0 flex-1 break-words">{t(`help.topics.${topic}.title`)}</span>
                    </Disclosure.Trigger>
                  </Disclosure.Heading>
                  <Disclosure.Content>
                    <Disclosure.Body className="pb-4 pl-7 text-sm text-muted">
                      {t.rich(`help.topics.${topic}.body`, { ...rich, withLogs })}
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>
              </div>
            ))}
          </DisclosureGroup>
        </Card.Content>
      </Card>
    </div>
  );
}
