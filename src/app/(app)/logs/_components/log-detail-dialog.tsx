"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Drawer,
  Dropdown,
  Label,
  Separator,
  Switch,
  Tabs,
  type useOverlayState,
} from "@heroui/react";
import { Braces, ChevronDown, Download, FileCode, FileText, Play, Route, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { loadAliasesAction } from "../_action";
import Markdown from "./markdown";
import CopyButton from "@/components/console/copy-button";
import SearchSelect from "@/components/console/search-select";
import { SectionLoading } from "@/components/console/page-status";
import { useGuardrailHitLabel } from "@/components/guardrails/guardrail-hit";
import { Link, useRouter } from "@/i18n/routing";
import { splitPiiPlaceholders } from "@/lib/gateway/safety/pii";
import { isActionFail } from "@/lib/http/action-result";
import type { RequestLogDetail, RequestLogExportFormat, TranscriptEntry } from "@/types/logs";
import GuardrailChip from "./guardrail-chip";
import LabelChips from "./label-chips";
import PiiChip from "./pii-chip";
import { PiiCode, PiiPlaceholder } from "./pii-placeholder";
import PiiRestore from "./pii-restore";
import StatusChip from "./status-chip";

const EXPORT_FORMATS: { id: RequestLogExportFormat; icon: LucideIcon }[] = [
  { id: "pdf", icon: FileText },
  { id: "md", icon: FileCode },
  { id: "json", icon: Braces },
];

function PiiText({ text }: { text: string }) {
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {splitPiiPlaceholders(text).map((part, index) =>
        part.entity ? (
          <PiiPlaceholder key={index} token={part.text} entity={part.entity} number={part.number} />
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function Entry({ entry, markdown }: { entry: TranscriptEntry; markdown: boolean }) {
  const t = useTranslations("Logs.detail");
  const heading =
    entry.kind === "tool_call"
      ? t("toolCall", { name: entry.name || "" })
      : entry.kind === "tool_result"
        ? t("toolResult")
        : entry.kind === "reasoning"
          ? t("reasoning")
          : null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="soft" color={entry.role === "assistant" ? "accent" : "default"}>
          {t("role", { role: entry.role })}
        </Chip>
        {heading ? <span className="text-xs text-muted">{heading}</span> : null}
      </div>
      {entry.kind === "media" ? (
        <p className="text-sm text-muted">{t("media", { media: entry.text })}</p>
      ) : entry.kind === "tool_call" || entry.kind === "tool_result" ? (
        <PiiCode text={entry.text} />
      ) : entry.kind === "reasoning" ? (
        markdown ? (
          <Markdown text={entry.text} pii muted />
        ) : (
          <div className="text-muted">
            <PiiText text={entry.text} />
          </div>
        )
      ) : markdown ? (
        <Markdown text={entry.text} pii />
      ) : (
        <PiiText text={entry.text} />
      )}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  const t = useTranslations("Logs.detail");
  if (value === null || value === undefined) return <p className="text-sm text-muted">{t("noJson")}</p>;
  return (
    <Card variant="secondary">
      <Card.Content>
        <PiiCode text={JSON.stringify(value, null, 2)} />
      </Card.Content>
    </Card>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function Content({ detail }: { detail: RequestLogDetail }) {
  const t = useTranslations("Logs.detail");
  const [markdown, setMarkdown] = useState(true);
  if (!detail.content) {
    const message = !detail.canViewContent && detail.hasContent
      ? t("noPermission")
      : t("contentMissing", { reason: detail.contentSkip || "none" });
    return (
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{message}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  const { input, output, request, response, truncated } = detail.content;
  return (
    <div className="space-y-3">
      {truncated ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("truncated")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Tabs aria-label={t("content")}>
        <Tabs.List aria-label={t("content")} className="w-fit">
          <Tabs.Tab id="conversation" className="w-auto">
            {t("conversation")}
          </Tabs.Tab>
          <Tabs.Tab id="request" className="w-auto">
            {t("requestJson")}
          </Tabs.Tab>
          <Tabs.Tab id="response" className="w-auto">
            {t("responseJson")}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="conversation" className="space-y-4 pt-4">
          {input.length || output.length ? (
            <>
              <Switch size="sm" isSelected={markdown} onChange={setMarkdown}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t("markdown")}</Label>
                </Switch.Content>
              </Switch>
              {input.map((entry, index) => (
                <Entry key={`in-${index}`} entry={entry} markdown={markdown} />
              ))}
              {input.length && output.length ? <Separator /> : null}
              {output.map((entry, index) => (
                <Entry key={`out-${index}`} entry={entry} markdown={markdown} />
              ))}
            </>
          ) : (
            <p className="text-sm text-muted">{t("noText")}</p>
          )}
        </Tabs.Panel>
        <Tabs.Panel id="request" className="pt-4">
          <Json value={request} />
        </Tabs.Panel>
        <Tabs.Panel id="response" className="pt-4">
          <Json value={response} />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

function Replay({ detail }: { detail: RequestLogDetail }) {
  const t = useTranslations("Logs.detail");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState("");

  useEffect(() => {
    loadAliasesAction().then((res) => {
      const aliases = isActionFail(res) ? [] : res.models;
      setModels(aliases);
      setModel(aliases.includes(detail.model) ? detail.model : "");
    });
  }, [detail.model]);

  return (
    <section className="space-y-3" aria-label={t("replayTitle")}>
      <h3 className="text-sm font-semibold">{t("replayTitle")}</h3>
      <p className="text-xs text-muted">{t("replayHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <SearchSelect
          label={t("replayModel")}
          placeholder={
            models === null ? tCommon("loading") : models.length === 0 ? t("replayNoModels") : t("replayPick")
          }
          items={(models ?? []).map((alias) => ({ id: alias, label: alias }))}
          value={model}
          onChange={setModel}
          isDisabled={!models?.length}
          className="min-w-44 flex-1"
        />
        <Button
          isDisabled={!model}
          onPress={() => router.push(`/developer?${new URLSearchParams({ tab: "playground", replay: detail.id, model })}`)}
        >
          <Play size={14} aria-hidden />
          {t("replay")}
        </Button>
      </div>
    </section>
  );
}

export default function LogDetailDialog({
  state,
  detail,
  onExport,
  onOpenSession,
}: {
  state: ReturnType<typeof useOverlayState>;
  detail: RequestLogDetail | null;
  onExport: (format: RequestLogExportFormat) => void;
  onOpenSession?: (detail: RequestLogDetail) => void;
}) {
  const t = useTranslations("Logs");
  const tDetail = useTranslations("Logs.detail");
  const tPii = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const hitLabel = useGuardrailHitLabel();
  const entities = (ids: string[]) =>
    ids.length ? format.list(ids.map((id) => tPii("entityLabel", { id })), "enumeration") : tCommon("none");
  const hits = (list: string[]) => (list.length ? format.list(list.map(hitLabel), "enumeration") : tCommon("none"));
  const label = (kind: "key" | "user" | "member" | "org" | "team" | "project", name: string, id: string) =>
    name || (id ? t("deleted", { kind }) : tCommon("none"));

  const facts = (current: RequestLogDetail) => [
    { id: "cost", label: t("columns.cost"), value: format.number(current.cost, "price") },
    {
      id: "tokens",
      label: t("columns.tokens"),
      value: t("tokenFlow", { prompt: current.promptTokens, completion: current.completionTokens }),
    },
    { id: "latency", label: t("columns.latency"), value: t("latencyMs", { value: current.latencyMs }) },
    {
      id: "cache",
      label: tDetail("cache"),
      value: tDetail("cacheValue", { read: current.cacheReadTokens, written: current.cacheWriteTokens }),
    },
  ];

  return (
    <Drawer.Backdrop variant="blur" isOpen={state.isOpen} onOpenChange={state.setOpen}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-full sm:w-2xl xl:w-3xl">
          <Drawer.CloseTrigger aria-label={tCommon("close")} />
          <Drawer.Header className="space-y-3 pr-10">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <Drawer.Heading className="break-words">{detail ? detail.model : tDetail("title")}</Drawer.Heading>
                {detail ? (
                  <p className="text-sm text-muted">{format.dateTime(new Date(detail.createdAt), "zoned")}</p>
                ) : null}
              </div>
              {detail ? (
                <Dropdown>
                  <Button size="sm" variant="secondary">
                    <Download size={14} aria-hidden />
                    {tDetail("export")}
                    <ChevronDown size={14} aria-hidden />
                  </Button>
                  <Dropdown.Popover placement="bottom end">
                    <Dropdown.Menu
                      aria-label={tDetail("export")}
                      onAction={(key) => {
                        const picked = EXPORT_FORMATS.find((item) => item.id === key);
                        if (picked) onExport(picked.id);
                      }}
                    >
                      {EXPORT_FORMATS.map(({ id, icon: Icon }) => (
                        <Dropdown.Item key={id} id={id} textValue={tDetail("exportFormat", { format: id })}>
                          <Icon size={14} aria-hidden />
                          <Label>{tDetail("exportFormat", { format: id })}</Label>
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              ) : null}
            </div>
            {detail ? (
              <div className="flex flex-wrap items-center gap-1">
                <StatusChip status={detail.status} outcome={detail.outcome} />
                {detail.stream ? (
                  <Chip size="sm" variant="soft" className="whitespace-nowrap">
                    {tDetail("streamed")}
                  </Chip>
                ) : null}
                {detail.agent ? (
                  <Chip size="sm" variant="soft" className="whitespace-nowrap">
                    {t("agent", { agent: detail.agent })}
                  </Chip>
                ) : null}
              </div>
            ) : null}
          </Drawer.Header>
          <Drawer.Body className="space-y-6">
            {!detail ? (
              <SectionLoading shape="details" />
            ) : (
              <>
                {detail.error ? (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>{tDetail("error")}</Alert.Title>
                      <Alert.Description className="break-words">{detail.error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
                <Card variant="secondary">
                  <Card.Content>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                      {facts(detail).map((fact) => (
                        <div key={fact.id} className="min-w-0">
                          <dt className="text-xs text-muted">{fact.label}</dt>
                          <dd className="text-sm font-medium break-words text-foreground tabular-nums">{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </Card.Content>
                </Card>

                <section className="space-y-3" aria-label={tDetail("caller")}>
                  <h3 className="text-sm font-semibold">{tDetail("caller")}</h3>
                  <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    {detail.system ? (
                      <Field label={t("columns.caller")}>
                        {t("caller.system")}
                        <span className="block text-xs text-muted">{t("caller.feature", { feature: detail.system })}</span>
                      </Field>
                    ) : null}
                    <Field label={tDetail("key")}>
                      {detail.keyId && detail.keyLabel ? (
                        <Link href={`/keys/${encodeURIComponent(detail.keyId)}`} className="text-accent">
                          {detail.keyLabel}
                        </Link>
                      ) : (
                        label("key", detail.keyLabel, detail.keyId)
                      )}
                    </Field>
                    <Field label={t("columns.org")}>
                      {detail.orgId && detail.orgLabel ? (
                        <Link href={`/companies/${encodeURIComponent(detail.orgId)}`} className="text-accent">
                          {detail.orgLabel}
                        </Link>
                      ) : (
                        label("org", detail.orgLabel, detail.orgId)
                      )}
                    </Field>
                    <Field label={tDetail("member")}>{label("member", detail.memberLabel, detail.memberId)}</Field>
                    <Field label={tDetail("user")}>{label("user", detail.userLabel, detail.userId)}</Field>
                    <Field label={tDetail("team")}>{label("team", detail.teamLabel, detail.teamId)}</Field>
                    <Field label={t("columns.project")}>{label("project", detail.projectLabel, detail.projectId)}</Field>
                  </dl>
                </section>

                <Separator />
                <section className="space-y-3" aria-label={tDetail("request")}>
                  <h3 className="text-sm font-semibold">{tDetail("request")}</h3>
                  <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    <Field label={tDetail("requestId")}>
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 font-mono text-xs break-all">{detail.id}</span>
                        <CopyButton text={detail.id} label={tDetail("copyId")} />
                      </span>
                    </Field>
                    <Field label={t("columns.endpoint")}>
                      <span className="font-mono text-xs break-all">{detail.endpoint || tCommon("none")}</span>
                    </Field>
                    <Field label={tDetail("upstream")}>
                      {detail.upstreamModel
                        ? tDetail("upstreamValue", { provider: detail.provider, model: detail.upstreamModel })
                        : tCommon("none")}
                    </Field>
                    <Field label={tDetail("tag")}>{detail.tag ? <PiiText text={detail.tag} /> : tCommon("none")}</Field>
                    <Field label={t("labels.title")} wide>
                      {detail.labels.length ? <LabelChips labels={detail.labels} /> : tCommon("none")}
                    </Field>
                    <Field label={tDetail("session")} wide>
                      {detail.sessionId ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 font-mono text-xs break-all">
                            <PiiText text={detail.sessionId} />
                          </div>
                          {onOpenSession ? (
                            <Button size="sm" variant="secondary" onPress={() => onOpenSession(detail)}>
                              <Route size={14} aria-hidden />
                              {tDetail("openSession")}
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        tCommon("none")
                      )}
                    </Field>
                  </dl>
                </section>

                <Separator />
                <section className="space-y-3" aria-label={tDetail("privacy")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{tDetail("privacy")}</h3>
                    <PiiChip
                      outcome={detail.outcome}
                      piiMode={detail.piiMode}
                      piiInput={detail.piiInput}
                      piiOutput={detail.piiOutput}
                    />
                    <GuardrailChip outcome={detail.outcome} guardInput={detail.guardInput} guardOutput={detail.guardOutput} />
                  </div>
                  <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    <Field label={tDetail("piiFilter")}>{tDetail("piiMode", { mode: detail.piiMode || "none" })}</Field>
                    <Field label={tDetail("piiPrompt")}>{entities(detail.piiInput)}</Field>
                    <Field label={tDetail("piiResponse")}>{entities(detail.piiOutput)}</Field>
                    <Field label={tDetail("guardPrompt")}>{hits(detail.guardInput)}</Field>
                    <Field label={tDetail("guardResponse")}>{hits(detail.guardOutput)}</Field>
                  </dl>
                  {detail.piiRestore ? <PiiRestore restore={detail.piiRestore} /> : null}
                  {detail.piiMode ? <p className="text-xs text-muted">{tDetail("piiStored", { mode: detail.piiMode })}</p> : null}
                </section>

                <Separator />
                <section className="space-y-3" aria-label={tDetail("content")}>
                  <h3 className="text-sm font-semibold">{tDetail("content")}</h3>
                  <Content detail={detail} />
                </section>
                {detail.replayable ? (
                  <>
                    <Separator />
                    <Replay detail={detail} />
                  </>
                ) : null}
              </>
            )}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
