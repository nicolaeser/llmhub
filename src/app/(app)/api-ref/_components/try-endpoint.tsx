"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import {
  Button,
  Card,
  Chip,
  Description,
  Input,
  Label,
  Modal,
  Spinner,
  Surface,
  Tabs,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import {
  ANTHROPIC_VERSION,
  exampleRequestBody,
  openApiPathParams,
} from "@/lib/gateway/openapi";
import type { OpenApiPath } from "@/types/gateway";
import type { OverlayState, TrySnapshot } from "@/types/api-ref";

const KEY_STORAGE = "llmhub.api-ref.bearer";
const MAX_SNAPSHOT = 1_000_000;
const keyListeners = new Set<() => void>();

function storageName(management: boolean): string {
  return management ? `${KEY_STORAGE}.management` : KEY_STORAGE;
}

function readStoredKey(name: string): string {
  try {
    return sessionStorage.getItem(name) ?? "";
  } catch {
    return "";
  }
}

function subscribeStoredKey(onStoreChange: () => void) {
  keyListeners.add(onStoreChange);
  return () => {
    keyListeners.delete(onStoreChange);
  };
}

function writeStoredKey(name: string, value: string) {
  try {
    if (value) sessionStorage.setItem(name, value);
    else sessionStorage.removeItem(name);
  } catch {
    return;
  }
  for (const listener of keyListeners) listener();
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function isTextType(contentType: string): boolean {
  return (
    !contentType ||
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("event-stream")
  );
}

async function snapshotOf(res: Response, started: number): Promise<TrySnapshot> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  const text = isTextType(contentType);
  return {
    status: res.status,
    latencyMs: Date.now() - started,
    contentType,
    bytes: buf.byteLength,
    binary: !text && buf.byteLength > 0,
    body: text
      ? new TextDecoder().decode(buf.subarray(0, MAX_SNAPSHOT))
      : "",
  };
}

function defaultParams(path: string, models: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of openApiPathParams(path)) {
    if (name === "id" && path.startsWith("/v1/models")) {
      out[name] = models[0] || "auto";
    } else if (name === "name") {
      out[name] = "web";
    } else {
      out[name] = "";
    }
  }
  return out;
}

export default function TryEndpoint({
  endpoint,
  models,
  state,
}: {
  endpoint: OpenApiPath;
  models: string[];
  state: OverlayState;
}) {
  const t = useTranslations("ApiRef");
  const tCommon = useTranslations("Common");
  const names = useMemo(
    () => openApiPathParams(endpoint.path),
    [endpoint.path],
  );
  const management = endpoint.style === "management";
  const storage = storageName(management);
  const apiKey = useSyncExternalStore(
    subscribeStoredKey,
    () => readStoredKey(storage),
    () => "",
  );
  const [format, setFormat] = useState(endpoint.style === "anthropic" ? "anthropic" : "openai");
  const anthropic = format === "anthropic";
  const [params, setParams] = useState(() =>
    defaultParams(endpoint.path, models),
  );
  const [body, setBody] = useState(
    () => exampleRequestBody(endpoint.method, endpoint.path, models[0] ?? "") ?? "",
  );
  const [result, setResult] = useState<TrySnapshot | null>(null);
  const [pending, start] = useTransition();

  function send() {
    if (pending) return;
    for (const name of names) {
      if (!params[name]?.trim()) {
        toast.danger(t("tryError", { code: "MISSING_PARAM" }));
        return;
      }
    }
    const needsBody = endpoint.method !== "GET" && endpoint.method !== "DELETE";
    let payload = "";
    if (needsBody) {
      payload = body.trim() || "{}";
      try {
        JSON.parse(payload);
      } catch {
        toast.danger(t("tryError", { code: "INVALID_JSON" }));
        return;
      }
    }
    const key = apiKey.trim();
    if (management && !key) {
      toast.danger(t("tryError", { code: "MANAGEMENT_KEY_REQUIRED" }));
      return;
    }
    start(async () => {
      const started = Date.now();
      try {
        if (key) {
          const filled = endpoint.path.replace(
            /\{([A-Za-z0-9_]+)\}/g,
            (_, name: string) => encodeURIComponent(params[name]!.trim()),
          );
          const res = await fetch(filled, {
            method: endpoint.method,
            headers: {
              ...(anthropic
                ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }
                : { Authorization: `Bearer ${key}` }),
              ...(needsBody ? { "Content-Type": "application/json" } : {}),
            },
            body: needsBody ? payload : undefined,
          });
          setResult(await snapshotOf(res, started));
          return;
        }
        const res = await fetch("/internal-api/api-ref/try", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: endpoint.method,
            path: endpoint.path,
            params,
            body: payload,
            format,
          }),
        });
        const json = (await res.json()) as {
          code?: string;
          status?: number;
          latencyMs?: number;
          contentType?: string;
          bytes?: number;
          binary?: boolean;
          body?: string;
        };
        if (!res.ok) {
          toast.danger(t("tryError", { code: json.code || "other" }));
          return;
        }
        setResult({
          status: json.status ?? 0,
          latencyMs: json.latencyMs ?? Date.now() - started,
          contentType: json.contentType ?? "",
          bytes: json.bytes ?? 0,
          binary: Boolean(json.binary),
          body: json.body ?? "",
        });
      } catch {
        toast.danger(t("tryError", { code: "other" }));
      }
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("tryTitle")}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" variant="soft">
                      {endpoint.method}
                    </Chip>
                    <code className="font-mono text-xs">{endpoint.path}</code>
                  </div>
                  <p className="text-sm text-muted">{t("tryHint", { surface: endpoint.style })}</p>
                  {endpoint.style === "dual" ? (
                    <Tabs
                      selectedKey={format}
                      onSelectionChange={(key) => setFormat(String(key))}
                      aria-label={t("formatLabel")}
                      className="w-fit"
                    >
                      <Tabs.List className="w-fit min-w-0" aria-label={t("formatLabel")}>
                        <Tabs.Tab id="openai" className="w-auto">
                          {t("format", { format: "openai" })}
                        </Tabs.Tab>
                        <Tabs.Tab id="anthropic" className="w-auto">
                          {t("format", { format: "anthropic" })}
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs>
                  ) : null}
                  {anthropic ? (
                    <p className="text-xs text-muted">{t("anthropicHeaders", { version: ANTHROPIC_VERSION })}</p>
                  ) : null}
                  <TextField fullWidth
                    value={apiKey}
                    onChange={(value) => writeStoredKey(storage, value)}
                    type="password"
                    aria-label={t("apiKey", { surface: endpoint.style })}
                  >
                    <Label>{t("apiKey", { surface: endpoint.style })}</Label>
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder={t("apiKeyPlaceholder", { surface: endpoint.style })}
                    />
                    <Description>
                      {t.rich("apiKeyHint", {
                        surface: endpoint.style,
                        keys: (chunks) => (
                          <Link href={management ? "/account" : "/keys"} className="text-accent">
                            {chunks}
                          </Link>
                        ),
                      })}
                    </Description>
                  </TextField>
                  {names.map((name) => (
                    <TextField fullWidth
                      key={name}
                      value={params[name] ?? ""}
                      onChange={(value) =>
                        setParams((cur) => ({ ...cur, [name]: value }))
                      }
                      aria-label={t("param", { name })}
                    >
                      <Label>{t("param", { name })}</Label>
                      <Input
                        aria-label={t("param", { name })}
                      />
                    </TextField>
                  ))}
                  {endpoint.method === "GET" || endpoint.method === "DELETE" ? null : (
                    <TextField fullWidth value={body} onChange={setBody}>
                      <Label>{t("body")}</Label>
                      <TextArea className="min-h-40 font-mono text-xs" />
                    </TextField>
                  )}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">{t("response")}</p>
                      {result ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip
                            size="sm"
                            variant="soft"
                            color={result.status < 400 ? "success" : "danger"}
                          >
                            {t("statusCode", { status: result.status })}
                          </Chip>
                          <span className="text-xs text-muted">
                            {t("latency", { ms: result.latencyMs })}
                          </span>
                        </div>
                      ) : null}
                    </div>
                    {result ? (
                      <Surface variant="secondary" className="overflow-x-auto rounded-xl p-4">
                        <pre className="font-mono text-xs whitespace-pre-wrap">
                          {result.binary
                            ? t("binaryResponse", {
                                type: result.contentType || "octet-stream",
                                bytes: result.bytes,
                              })
                            : pretty(result.body) || t("emptyResponse")}
                        </pre>
                      </Surface>
                    ) : (
                      <Card variant="secondary" className="items-center py-6 text-center">
                        <Card.Description>{t("responseEmpty")}</Card.Description>
                      </Card>
                    )}
                  </div>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="tertiary"
                    onPress={close}
                    aria-label={tCommon("close")}
                  >
                    {tCommon("close")}
                  </Button>
                  <Button
                    isPending={pending}
                    onPress={send}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("send")}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
