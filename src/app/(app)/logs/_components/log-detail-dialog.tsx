"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Dropdown,
  Label,
  Modal,
  Separator,
  Spinner,
  Switch,
  Tabs,
  type useOverlayState,
} from "@heroui/react";
import { Braces, ChevronDown, Download, FileCode, FileText, Play, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { loadAliasesAction } from "@/app/(app)/_action";
import Markdown from "@/components/console/markdown";
import SearchSelect from "@/components/console/search-select";
import { useRouter } from "@/i18n/routing";
import { splitPiiPlaceholders } from "@/lib/gateway/pii";
import { isActionFail } from "@/lib/http/action-result";
import type { RequestLogDetail, RequestLogExportFormat, TranscriptEntry } from "@/types/logs";
import PiiChip from "./pii-chip";

const EXPORT_FORMATS: { id: RequestLogExportFormat; icon: LucideIcon }[] = [
  { id: "pdf", icon: FileText },
  { id: "md", icon: FileCode },
  { id: "json", icon: Braces },
];

function PiiText({ text }: { text: string }) {
  const tPii = useTranslations("Guardrails");
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {splitPiiPlaceholders(text).map((part, index) =>
        part.entity ? (
          <Chip key={index} size="sm" variant="soft" color="warning">
            {tPii("entityLabel", { id: part.entity })}
          </Chip>
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
        <pre className="font-mono text-xs break-all whitespace-pre-wrap">{entry.text}</pre>
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
        <pre className="font-mono text-xs break-all whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
      </Card.Content>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
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
    <Modal.Footer className="flex-col items-stretch">
      <p className="text-xs text-muted">{t("replayHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <SearchSelect
          label={t("replayModel")}
          placeholder={models?.length === 0 ? t("replayNoModels") : t("replayPick")}
          items={(models ?? []).map((alias) => ({ id: alias, label: alias }))}
          value={model}
          onChange={setModel}
          isDisabled={!models?.length}
          className="min-w-44 flex-1"
        />
        <Button
          isDisabled={!model}
          onPress={() => router.push(`/playground?${new URLSearchParams({ replay: detail.id, model })}`)}
        >
          <Play size={14} aria-hidden />
          {t("replay")}
        </Button>
      </div>
    </Modal.Footer>
  );
}

export default function LogDetailDialog({
  state,
  detail,
  onExport,
}: {
  state: ReturnType<typeof useOverlayState>;
  detail: RequestLogDetail | null;
  onExport: (format: RequestLogExportFormat) => void;
}) {
  const t = useTranslations("Logs");
  const tDetail = useTranslations("Logs.detail");
  const tPii = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const entities = (ids: string[]) =>
    ids.length ? format.list(ids.map((id) => tPii("entityLabel", { id })), "enumeration") : tCommon("none");
  const label = (kind: "key" | "user" | "member" | "org" | "team" | "project", name: string, id: string) =>
    name || (id ? t("deleted", { kind }) : tCommon("none"));

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container scroll="inside">
          <Modal.Dialog className="sm:min-w-lg sm:max-w-5xl">
            <Modal.CloseTrigger aria-label={tCommon("close")} />
            <Modal.Header>
              <div className="flex flex-wrap items-start justify-between gap-3 pr-10">
                <div className="min-w-0 space-y-1">
                  <Modal.Heading>{tDetail("title")}</Modal.Heading>
                  {detail ? (
                    <p className="text-sm text-muted">
                      {tDetail("subtitle", {
                        model: detail.model,
                        time: format.dateTime(new Date(detail.createdAt), "dateTime"),
                      })}
                    </p>
                  ) : null}
                </div>
                {detail ? (
                  <Dropdown>
                    <Button size="sm" variant="secondary">
                      <Download size={14} aria-hidden />
                      {tDetail("export")}
                      <ChevronDown size={14} aria-hidden />
                    </Button>
                    <Dropdown.Popover>
                      <Dropdown.Menu
                        aria-label={tDetail("export")}
                        onAction={(key) => onExport(String(key) as RequestLogExportFormat)}
                      >
                        {EXPORT_FORMATS.map(({ id, icon: Icon }) => (
                          <Dropdown.Item key={id} id={id} textValue={tDetail("exportFormat", { format: id })}>
                            <div className="flex items-center gap-2">
                              <Icon size={14} aria-hidden />
                              <Label>{tDetail("exportFormat", { format: id })}</Label>
                            </div>
                          </Dropdown.Item>
                        ))}
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                ) : null}
              </div>
            </Modal.Header>
            <Modal.Body className="space-y-5">
              {!detail ? (
                <output
                  aria-live="polite"
                  aria-label={tCommon("loading")}
                  className="flex min-h-40 items-center justify-center text-accent"
                >
                  <Spinner color="current" />
                </output>
              ) : (
                <>
                  {detail.error ? (
                    <Alert status="danger">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Title>{tDetail("error")}</Alert.Title>
                        <Alert.Description>{detail.error}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}
                  <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label={tDetail("requestId")}>
                      <span className="font-mono text-xs">{detail.id}</span>
                    </Field>
                    <Field label={t("columns.endpoint")}>
                      <span className="font-mono text-xs">{detail.endpoint || tCommon("none")}</span>
                    </Field>
                    <Field label={t("columns.status")}>
                      {t("statusOutcome", { status: detail.status, outcome: detail.outcome })}
                    </Field>
                    <Field label={tDetail("upstream")}>
                      {detail.upstreamModel
                        ? tDetail("upstreamValue", { provider: detail.provider, model: detail.upstreamModel })
                        : tCommon("none")}
                    </Field>
                    <Field label={tDetail("stream")}>{tDetail("yesNo", { value: String(detail.stream) })}</Field>
                    <Field label={tDetail("tag")}>{detail.tag ? <PiiText text={detail.tag} /> : tCommon("none")}</Field>
                    <Field label={tDetail("key")}>{label("key", detail.keyLabel, detail.keyId)}</Field>
                    <Field label={tDetail("user")}>{label("user", detail.userLabel, detail.userId)}</Field>
                    <Field label={tDetail("member")}>{label("member", detail.memberLabel, detail.memberId)}</Field>
                    <Field label={t("columns.org")}>{label("org", detail.orgLabel, detail.orgId)}</Field>
                    <Field label={tDetail("team")}>{label("team", detail.teamLabel, detail.teamId)}</Field>
                    <Field label={t("columns.project")}>{label("project", detail.projectLabel, detail.projectId)}</Field>
                    <Field label={t("columns.latency")}>{t("latencyMs", { value: detail.latencyMs })}</Field>
                    <Field label={t("columns.tokens")}>
                      {t("tokenSplit", { prompt: detail.promptTokens, completion: detail.completionTokens })}
                    </Field>
                    <Field label={tDetail("cache")}>
                      {tDetail("cacheValue", { read: detail.cacheReadTokens, written: detail.cacheWriteTokens })}
                    </Field>
                    <Field label={t("columns.cost")}>{format.number(detail.cost, "money")}</Field>
                  </dl>
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
                    </div>
                    <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
                      <Field label={tDetail("piiFilter")}>
                        {tDetail("piiMode", { mode: detail.piiMode || "none" })}
                      </Field>
                      <Field label={tDetail("piiPrompt")}>{entities(detail.piiInput)}</Field>
                      <Field label={tDetail("piiResponse")}>{entities(detail.piiOutput)}</Field>
                    </dl>
                    {detail.piiMode ? (
                      <p className="text-xs text-muted">{tDetail("piiStored")}</p>
                    ) : null}
                  </section>
                  <Separator />
                  <section className="space-y-3" aria-label={tDetail("content")}>
                    <h3 className="text-sm font-semibold">{tDetail("content")}</h3>
                    <Content detail={detail} />
                  </section>
                </>
              )}
            </Modal.Body>
            {detail?.replayable ? <Replay detail={detail} /> : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
