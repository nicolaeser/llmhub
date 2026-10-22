"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  SearchField,
  Surface,
  Table,
  Tabs,
  useOverlayState,
} from "@heroui/react";
import { Code2, KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { loadApiRefAction } from "../_action";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useOrigin } from "@/lib/hooks/use-origin";
import { GATEWAY_ERRORS } from "@/lib/gateway/errors";
import { ANTHROPIC_LEGACY_VERSION, ANTHROPIC_VERSION } from "@/lib/gateway/endpoints/openapi";
import { API_PREFIX, MANAGEMENT_PREFIX, SUBSCRIPTION_PREFIX } from "@/lib/gateway/api-paths";
import { PROBLEMS } from "@/lib/http/problem-codes";
import TryEndpoint from "./try-endpoint";
import type { OpenApiPath } from "@/types/api-ref";

const CHAT_CURL_BODY =
  '\'{"model":"my-alias","messages":[{"role":"user","content":"Hello"}]}\'';
const MESSAGES_CURL_BODY =
  '\'{"model":"my-alias","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}\'';
const EXAMPLE_STYLES = ["openai", "anthropic", "management"] as const;
const CLI_CLIENTS = ["claude", "codex", "cursor"] as const;

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
    instance: `${MANAGEMENT_PREFIX}/teams`,
    code: "VALIDATION",
    request_id: "req_0123456789abcdef01234567",
    errors: [{ pointer: "#/alias", detail: "Too small: expected string to have >=1 characters" }],
  },
} as const;

export default function ApiTab() {
  const t = useTranslations("ApiRef");
  const tCommon = useTranslations("Common");
  const origin = useOrigin();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<OpenApiPath | null>(null);
  const [example, setExample] = useState<string>("openai");
  const [cli, setCli] = useState<string>("claude");
  const [errorShape, setErrorShape] = useState<string>("openai");
  const tryState = useOverlayState();
  const page = useActionData(loadApiRefAction);
  const paths = page.data?.paths;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!paths || !q) return paths ?? [];
    return paths.filter(
      (p) =>
        p.method.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.style.includes(q),
    );
  }, [paths, query]);

  if (!page.data) {
    return <PageStatus state={page} layout="panels" />;
  }

  const { keys, models, canTry } = page.data;

  const curl =
    example === "anthropic"
      ? t("curlAnthropic", { origin, version: ANTHROPIC_VERSION, body: MESSAGES_CURL_BODY })
      : example === "management"
        ? t("curlManagement", { origin })
        : t("curl", { origin, body: CHAT_CURL_BODY });
  const cliSetup =
    cli === "codex"
      ? t("cliCodex", { openai: `${origin}${SUBSCRIPTION_PREFIX}/v1` })
      : cli === "cursor"
        ? t("cliCursor", { openai: `${origin}${API_PREFIX}/v1` })
        : t("cliClaude", { anthropic: `${origin}${SUBSCRIPTION_PREFIX}` });
  const bases = [
    {
      id: "openai",
      urls: [{ label: t("baseUrl"), value: `${origin}${API_PREFIX}/v1` }],
      hint: t("auth"),
    },
    {
      id: "anthropic",
      urls: [{ label: t("baseUrl"), value: `${origin}${API_PREFIX}` }],
      hint: t("anthropicAuth", { version: ANTHROPIC_VERSION, legacy: ANTHROPIC_LEGACY_VERSION }),
    },
    {
      id: "subscription",
      urls: [
        { label: t("baseUrlFor", { client: "openai" }), value: `${origin}${SUBSCRIPTION_PREFIX}/v1` },
        { label: t("baseUrlFor", { client: "anthropic" }), value: `${origin}${SUBSCRIPTION_PREFIX}` },
      ],
      hint: t("subscriptionAuth"),
    },
    {
      id: "management",
      urls: [{ label: t("baseUrl"), value: `${origin}${MANAGEMENT_PREFIX}` }],
      hint: null,
    },
  ];

  function styleChip(row: OpenApiPath) {
    return (
      <Chip size="sm" variant="soft" color={row.style === "management" ? "accent" : "default"}>
        {t("style", { style: row.style })}
      </Chip>
    );
  }

  function tryButton(row: OpenApiPath) {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-label={t("tryAria", { method: row.method, path: row.path })}
        onPress={() => {
          setSelected(row);
          tryState.open();
        }}
      >
        {tCommon("test")}
      </Button>
    );
  }

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted">{t("subtitle")}</p>

      <div className="grid gap-5 lg:grid-cols-2">
        {bases.map((base) => (
          <Card key={base.id} className="gap-3">
            <Card.Header>
              <Card.Title>{t("sdkTitle", { style: base.id })}</Card.Title>
              <Card.Description>{t("sdkDescription", { style: base.id })}</Card.Description>
            </Card.Header>
            {base.urls.map((url) => (
              <div key={url.value} className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{url.label}</p>
                  <code className="mt-1 block break-all font-mono text-sm">{url.value}</code>
                </div>
                <CopyButton text={url.value} label={tCommon("copy")} showLabel />
              </div>
            ))}
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

      <Card className="gap-3">
        <Card.Header>
          <Card.Title>{t("cliTitle")}</Card.Title>
          <Card.Description>{t("cliDescription")}</Card.Description>
        </Card.Header>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs selectedKey={cli} onSelectionChange={(key) => setCli(String(key))} aria-label={t("cliLabel")} className="w-fit">
            <Tabs.List className="w-fit min-w-0" aria-label={t("cliLabel")}>
              {CLI_CLIENTS.map((client) => (
                <Tabs.Tab key={client} id={client} className="w-auto">
                  {t("cliName", { client })}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
          <CopyButton text={cliSetup} label={tCommon("copy")} showLabel />
        </div>
        <Surface variant="secondary" className="overflow-x-auto rounded-xl p-4">
          <pre className="font-mono text-xs whitespace-pre-wrap">{cliSetup}</pre>
        </Surface>
        <p className="text-sm text-muted">{t("cliHint", { client: cli })}</p>
      </Card>

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
          <CopyButton text={curl} label={tCommon("copy")} showLabel />
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
          className="w-full max-w-sm"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("searchPlaceholder")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
        {filtered.length === 0 ? (
          <EmptyState icon={Code2} title={t("empty")} />
        ) : (
          <>
            <RowCards label={t("endpoints")}>
              {filtered.map((row) => (
                <RowCard
                  key={`${row.method}:${row.path}`}
                  title={<code className="font-mono text-xs break-words">{row.path}</code>}
                  description={row.summary}
                  chips={
                    <>
                      <Chip size="sm" variant="soft">
                        {row.method}
                      </Chip>
                      {styleChip(row)}
                    </>
                  }
                  actions={canTry ? tryButton(row) : undefined}
                />
              ))}
            </RowCards>
            <Table aria-label={t("endpoints")} className={TABLE_FROM_LG}>
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
                        <Table.Cell>{styleChip(row)}</Table.Cell>
                        <Table.Cell>{row.summary}</Table.Cell>
                        {canTry ? <Table.Cell>{tryButton(row)}</Table.Cell> : null}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </>
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
          <RowCards label={t("problemCodes")}>
            {Object.entries(PROBLEMS).map(([code, spec]) => (
              <RowCard
                key={code}
                title={<code className="font-mono text-xs break-words">{code}</code>}
                description={spec.title}
                aside={
                  <Chip size="sm" variant="soft">
                    {t("statusCode", { status: spec.status })}
                  </Chip>
                }
              />
            ))}
          </RowCards>
          <Table aria-label={t("problemCodes")} className={TABLE_FROM_LG}>
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
          <EmptyState icon={KeyRound} title={t("noKeys")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((key) => (
              <li key={key.prefix}>
                <Card className="flex-row flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{key.alias || t("keyAlias")}</div>
                    <code className="font-mono text-xs text-muted">{key.prefix}…</code>
                  </div>
                  <CopyButton text={key.prefix} label={tCommon("copy")} showLabel />
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
