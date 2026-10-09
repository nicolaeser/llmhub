"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  SearchField,
  Spinner,
  Surface,
  Table,
  Tabs,
  toast,
  useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { loadApiRefAction } from "@/app/(app)/api-ref/_action";
import { Link } from "@/i18n/routing";
import { isActionFail } from "@/lib/http/action-result";
import { useOrigin } from "@/lib/hooks/use-origin";
import { GATEWAY_ERRORS } from "@/lib/gateway/errors";
import { ANTHROPIC_VERSION } from "@/lib/gateway/openapi";
import { SUBSCRIPTION_PREFIX } from "@/lib/gateway/route-pool";
import { PROBLEMS } from "@/lib/http/problems";
import CopyButton from "./_components/copy-button";
import TryEndpoint from "./_components/try-endpoint";
import type { OpenApiPath } from "@/types/gateway";
import type { KeyPrefix } from "@/types/api-ref";

const CHAT_CURL_BODY =
  '\'{"model":"my-alias","messages":[{"role":"user","content":"Hello"}]}\'';
const MESSAGES_CURL_BODY =
  '\'{"model":"my-alias","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}\'';
const EXAMPLE_STYLES = ["openai", "anthropic", "management"] as const;

const ERROR_EXAMPLES = {
  openai: {
    error: {
      message: "model not allowed for this key",
      type: "permission_error",
      param: "model",
      code: "model_access_denied",
    },
  },
  anthropic: {
    type: "error",
    error: { type: "permission_error", message: "model not allowed for this key" },
    request_id: "req_0123456789abcdef01234567",
  },
  management: {
    title: "Validation failed",
    status: 422,
    detail: "Validation failed",
    instance: "/api/teams",
    code: "VALIDATION",
    request_id: "req_0123456789abcdef01234567",
    errors: [{ pointer: "#/alias", detail: "Too small: expected string to have >=1 characters" }],
  },
} as const;

export default function ApiRefPage() {
  const t = useTranslations("ApiRef");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const origin = useOrigin();
  const [paths, setPaths] = useState<OpenApiPath[]>([]);
  const [keys, setKeys] = useState<KeyPrefix[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [canTry, setCanTry] = useState(false);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [selected, setSelected] = useState<OpenApiPath | null>(null);
  const [example, setExample] = useState<string>("openai");
  const [errorShape, setErrorShape] = useState<string>("openai");
  const tryState = useOverlayState();

  useEffect(() => {
    loadApiRefAction().then((res) => {
      if (!isActionFail(res)) {
        setPaths(res.paths);
        setKeys(res.keys);
        setModels(res.models);
        setCanTry(res.canTry);
      } else {
        toast.danger(tError("code", { code: res.error }));
      }
      setLoading(false);
    });
  }, [tError]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return paths;
    return paths.filter(
      (p) =>
        p.method.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.style.includes(q),
    );
  }, [paths, query]);

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const curl =
    example === "anthropic"
      ? t("curlAnthropic", { origin, version: ANTHROPIC_VERSION, body: MESSAGES_CURL_BODY })
      : example === "management"
        ? t("curlManagement", { origin })
        : t("curl", { origin, body: CHAT_CURL_BODY });
  const bases = [
    { id: "openai", value: `${origin}/v1`, hint: t("auth") },
    { id: "anthropic", value: origin, hint: t("anthropicAuth", { version: ANTHROPIC_VERSION }) },
    {
      id: "subscription",
      value: `${origin}${SUBSCRIPTION_PREFIX}/v1`,
      hint: t("subscriptionAuth", { anthropic: `${origin}${SUBSCRIPTION_PREFIX}` }),
    },
    { id: "management", value: `${origin}/api`, hint: null },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-5 lg:grid-cols-2">
        {bases.map((base) => (
          <Card key={base.id} className="gap-3">
            <Card.Header>
              <Card.Title>{t("sdkTitle", { style: base.id })}</Card.Title>
              <Card.Description>{t("sdkDescription", { style: base.id })}</Card.Description>
            </Card.Header>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("baseUrl")}</p>
                <code className="mt-1 block break-all font-mono text-sm">{base.value}</code>
              </div>
              <CopyButton
                value={base.value}
                id={`base:${base.id}`}
                copied={copied}
                copyLabel={tCommon("copy")}
                copiedLabel={tCommon("copied")}
                onCopied={setCopied}
              />
            </div>
            <Alert>
              <Alert.Content>
                <Alert.Description>
                  {base.hint ??
                    t.rich("managementAuth", {
                      account: (chunks) => (
                        <Link href="/account" className="text-accent">
                          {chunks}
                        </Link>
                      ),
                    })}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          </Card>
        ))}
      </div>

      <Card>
        <Card.Header className="flex-row flex-wrap items-center justify-between gap-2">
          <Tabs
            selectedKey={example}
            onSelectionChange={(key) => setExample(String(key))}
            aria-label={t("examplesLabel")}
            className="w-fit"
          >
            <Tabs.List className="w-fit min-w-0" aria-label={t("examplesLabel")}>
              {EXAMPLE_STYLES.map((style) => (
                <Tabs.Tab key={style} id={style} className="w-auto">
                  {t("curlTitle", { style })}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
          <CopyButton
            value={curl}
            id="curl"
            copied={copied}
            copyLabel={tCommon("copy")}
            copiedLabel={tCommon("copied")}
            onCopied={setCopied}
          />
        </Card.Header>
        <Surface variant="secondary" className="overflow-x-auto rounded-xl p-4">
          <pre className="font-mono text-xs whitespace-pre-wrap">{curl}</pre>
        </Surface>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t("endpoints")}</h2>
        <SearchField
          value={query}
          onChange={setQuery}
          aria-label={t("searchPlaceholder")}
          className="max-w-sm"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("searchPlaceholder")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
        {filtered.length === 0 ? (
          <Card className="items-center py-10 text-center">
            <Card.Description>{t("empty")}</Card.Description>
          </Card>
        ) : (
          <Table aria-label={t("endpoints")}>
            <Table.ScrollContainer>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.method")}</Table.Column>
                  <Table.Column>{t("columns.path")}</Table.Column>
                  <Table.Column>{t("columns.style")}</Table.Column>
                  <Table.Column>{t("columns.summary")}</Table.Column>
                  {canTry ? (
                    <Table.Column>{tCommon("actions")}</Table.Column>
                  ) : null}
                </Table.Header>
                <Table.Body>
                  {filtered.map((row) => (
                    <Table.Row
                      key={`${row.method}:${row.path}`}
                      id={`${row.method}:${row.path}`}
                    >
                      <Table.Cell>
                        <Chip size="sm" variant="soft">
                          {row.method}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <code className="font-mono text-xs">{row.path}</code>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft" color={row.style === "management" ? "accent" : "default"}>
                          {t("style", { style: row.style })}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>{row.summary}</Table.Cell>
                      {canTry ? (
                        <Table.Cell>
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label={t("tryAria", {
                              method: row.method,
                              path: row.path,
                            })}
                            onPress={() => {
                              setSelected(row);
                              tryState.open();
                            }}
                          >
                            {tCommon("test")}
                          </Button>
                        </Table.Cell>
                      ) : null}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </section>

      <section className="space-y-3" id="errors">
        <div>
          <h2 className="text-sm font-medium">{t("errorsTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("errorsHint")}</p>
        </div>
        <Card>
          <Card.Header className="flex-row flex-wrap items-center justify-between gap-2">
            <Tabs
              selectedKey={errorShape}
              onSelectionChange={(key) => setErrorShape(String(key))}
              aria-label={t("errorShapesLabel")}
              className="w-fit"
            >
              <Tabs.List className="w-fit min-w-0" aria-label={t("errorShapesLabel")}>
                {EXAMPLE_STYLES.map((style) => (
                  <Tabs.Tab key={style} id={style} className="w-auto">
                    {t("errorShape", { style })}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs>
          </Card.Header>
          <Card.Description>{t("errorShapeHint", { style: errorShape })}</Card.Description>
          <Surface variant="secondary" className="overflow-x-auto rounded-xl p-4">
            <pre className="font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(
                errorShape === "management"
                  ? { type: `${origin}/api-ref#error-VALIDATION`, ...ERROR_EXAMPLES.management }
                  : errorShape === "anthropic"
                    ? ERROR_EXAMPLES.anthropic
                    : ERROR_EXAMPLES.openai,
                null,
                2,
              )}
            </pre>
          </Surface>
        </Card>
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <Table aria-label={t("problemCodes")}>
            <Table.ScrollContainer>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>{t("problemCodes")}</Table.Column>
                  <Table.Column>{t("columns.status")}</Table.Column>
                  <Table.Column>{t("columns.title")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {Object.entries(PROBLEMS).map(([code, spec]) => (
                    <Table.Row key={code} id={code}>
                      <Table.Cell>
                        <code id={`error-${code}`} className="font-mono text-xs">
                          {code}
                        </code>
                      </Table.Cell>
                      <Table.Cell>{t("statusCode", { status: spec.status })}</Table.Cell>
                      <Table.Cell>{spec.title}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          <Table aria-label={t("gatewayCodes")}>
            <Table.ScrollContainer>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>{t("gatewayCodes")}</Table.Column>
                  <Table.Column>{t("columns.status")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {Object.entries(GATEWAY_ERRORS).map(([code, status]) => (
                    <Table.Row key={code} id={code}>
                      <Table.Cell>
                        <code className="font-mono text-xs">{code}</code>
                      </Table.Cell>
                      <Table.Cell>{t("statusCode", { status })}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">{t("keysTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("keysHint")}</p>
        </div>
        {keys.length === 0 ? (
          <Card className="items-center py-10 text-center">
            <Card.Description>{t("noKeys")}</Card.Description>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((key) => (
              <li key={key.prefix}>
                <Card className="flex-row flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{key.alias || t("keyAlias")}</div>
                    <code className="font-mono text-xs text-muted">{key.prefix}…</code>
                  </div>
                  <CopyButton
                    value={key.prefix}
                    id={`key:${key.prefix}`}
                    copied={copied}
                    copyLabel={tCommon("copy")}
                    copiedLabel={tCommon("copied")}
                    onCopied={setCopied}
                  />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected && canTry ? (
        <TryEndpoint
          key={`${selected.method}:${selected.path}`}
          endpoint={selected}
          models={models}
          state={tryState}
        />
      ) : null}
    </div>
  );
}
