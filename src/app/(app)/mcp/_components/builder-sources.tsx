"use client";

import { useRef, type Dispatch, type SetStateAction } from "react";
import {
  Alert,
  Button,
  Card,
  Description,
  FieldError,
  Fieldset,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { Plus, Trash2, Upload } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { formatBytes } from "@/lib/utils/bytes";
import {
  MAX_BUILDER_DOCS,
  MAX_BUILDER_FILES,
  MAX_BUILDER_FILE_BYTES,
  MAX_BUILDER_LINKS,
  MAX_CRAWL_DEPTH,
  MAX_BUILDER_UPLOAD_BYTES,
  MCP_BUILDER_FILE_EXTENSIONS,
  MCP_DOCS_AUTH_TYPES,
  builderLinkSchema,
} from "@/schemas/mcp";
import type { McpDocsFileRow, McpDocsLink, McpDocsLinkRow } from "@/types/mcp";

const ACCEPT = MCP_BUILDER_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",");
const FILE_EXTENSIONS = new Set<string>(MCP_BUILDER_FILE_EXTENSIONS);

function rowKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function linkIssues(link: McpDocsLink) {
  const issues: Partial<Record<"url" | "name" | "secret", string>> = {};
  const parsed = builderLinkSchema.safeParse(link);
  if (parsed.success) return issues;
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if ((field === "url" || field === "name" || field === "secret") && !issues[field]) issues[field] = issue.message;
  }
  return issues;
}

export function sourcesReady(links: McpDocsLinkRow[], docs: string, files: McpDocsFileRow[]): boolean {
  const filled = links.length > 0 || docs.trim().length > 0 || files.length > 0;
  return filled && docs.length <= MAX_BUILDER_DOCS && links.every((row) => Object.keys(linkIssues(row)).length === 0);
}

export default function BuilderSources({
  links,
  docs,
  files,
  errors,
  pending,
  onLinks,
  onDocs,
  onFiles,
  onErrors,
}: {
  links: McpDocsLinkRow[];
  docs: string;
  files: McpDocsFileRow[];
  errors: Record<string, string>;
  pending: boolean;
  onLinks: Dispatch<SetStateAction<McpDocsLinkRow[]>>;
  onDocs: (docs: string) => void;
  onFiles: Dispatch<SetStateAction<McpDocsFileRow[]>>;
  onErrors: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const t = useTranslations("Mcp");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const showError = useErrorToast();
  const picker = useRef<HTMLInputElement>(null);
  const docsTooLong = docs.length > MAX_BUILDER_DOCS;

  function clearError(key: string) {
    onErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function addLink() {
    onLinks((current) => [
      ...current,
      { key: rowKey("link"), url: "", internal: false, crawl: true, auth: "none", name: "", secret: "" },
    ]);
  }

  function patchLink(key: string, change: Partial<McpDocsLink>) {
    clearError(key);
    onLinks((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function removeLink(key: string) {
    clearError(key);
    onLinks((current) => current.filter((row) => row.key !== key));
  }

  function editDocs(value: string) {
    clearError("docs");
    onDocs(value);
  }

  function addFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const accepted: McpDocsFileRow[] = [];
    let total = files.reduce((sum, row) => sum + row.file.size, 0);
    let failure = "";
    for (const file of picked) {
      const known = files.some(
        (row) => row.file.name === file.name && row.file.size === file.size && row.file.lastModified === file.lastModified,
      );
      if (known) continue;
      if (!FILE_EXTENSIONS.has(extensionOf(file.name)) || !file.size) failure ||= "MCP_BUILDER_FILE_UNSUPPORTED";
      else if (file.size > MAX_BUILDER_FILE_BYTES) failure ||= "MCP_BUILDER_FILE_SIZE";
      else if (files.length + accepted.length >= MAX_BUILDER_FILES) failure ||= "MCP_BUILDER_FILES_COUNT";
      else if (total + file.size > MAX_BUILDER_UPLOAD_BYTES) failure ||= "MCP_BUILDER_FILES_SIZE";
      else {
        total += file.size;
        accepted.push({ key: rowKey("file"), file });
      }
    }
    if (accepted.length) onFiles((current) => [...current, ...accepted]);
    if (failure) showError(failure);
  }

  function removeFile(key: string) {
    clearError(key);
    onFiles((current) => current.filter((row) => row.key !== key));
  }

  return (
    <Fieldset className="gap-4">
      <Fieldset.Legend>{t("builder.docsTitle")}</Fieldset.Legend>
      <p className="text-sm text-muted">{t("builder.docsIntro")}</p>
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{t("builder.docsPrivacy")}</Alert.Description>
        </Alert.Content>
      </Alert>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">{t("builder.links")}</p>
            <p className="text-sm text-muted">{t("builder.linksHint", { max: MAX_BUILDER_LINKS })}</p>
          </div>
          <Button size="sm" variant="secondary" onPress={addLink} isDisabled={pending || links.length >= MAX_BUILDER_LINKS}>
            <Plus size={14} aria-hidden />
            {t("builder.addLink")}
          </Button>
        </div>
        {links.map((row, index) => {
          const issues = linkIssues(row);
          const shown = (field: "url" | "name" | "secret") => (issues[field] && issues[field] !== "required" ? issues[field] : "");
          const credentialsFailed = errors[row.key] === "MCP_BUILDER_FETCH_AUTH" && row.auth !== "none";
          const failed = credentialsFailed ? "" : errors[row.key];
          const urlIssue = shown("url");
          const nameIssue = shown("name");
          const secretIssue = shown("secret");
          const named = row.auth === "basic" || row.auth === "header" || row.auth === "query";
          return (
            <Card key={row.key} variant="secondary">
              <Card.Content>
                <Fieldset className="gap-4">
                  <Fieldset.Legend>{t("builder.linkTitle", { index: index + 1 })}</Fieldset.Legend>
                  <TextField
                    fullWidth
                    isRequired
                    value={row.url}
                    onChange={(url) => patchLink(row.key, { url })}
                    isDisabled={pending}
                    isInvalid={Boolean(failed || urlIssue)}
                  >
                    <Label>{t("builder.linkUrl")}</Label>
                    <Input inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://docs.example.com/openapi.json" />
                    {failed ? (
                      <FieldError>{tError("code", { code: failed })}</FieldError>
                    ) : urlIssue ? (
                      <FieldError>{t("builder.linkUrlIssue", { issue: urlIssue })}</FieldError>
                    ) : (
                      <Description>{t("builder.linkUrlHint")}</Description>
                    )}
                  </TextField>
                  <Select
                    fullWidth
                    selectedKey={row.auth}
                    onSelectionChange={(key) => {
                      const auth = MCP_DOCS_AUTH_TYPES.find((type) => type === String(key));
                      if (auth) patchLink(row.key, { auth, name: "", secret: "" });
                    }}
                    isDisabled={pending}
                  >
                    <Label>{t("builder.linkAuth")}</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {MCP_DOCS_AUTH_TYPES.map((type) => (
                          <ListBox.Item key={type} id={type} textValue={t("builder.linkAuthOption", { type })}>
                            {t("builder.linkAuthOption", { type })}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                    <Description>{t("builder.linkAuthHint", { type: row.auth })}</Description>
                  </Select>
                  {row.auth !== "none" ? (
                    <div className={named ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
                      {named ? (
                        <TextField
                          fullWidth
                          isRequired
                          value={row.name}
                          onChange={(name) => patchLink(row.key, { name })}
                          isDisabled={pending}
                          isInvalid={Boolean(nameIssue)}
                        >
                          <Label>{t("builder.linkName", { type: row.auth })}</Label>
                          <Input
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={t("builder.linkNamePlaceholder", { type: row.auth })}
                          />
                          {nameIssue ? <FieldError>{t("builder.linkNameIssue", { type: row.auth })}</FieldError> : null}
                        </TextField>
                      ) : null}
                      <TextField
                        fullWidth
                        isRequired={row.auth !== "basic"}
                        value={row.secret}
                        onChange={(secret) => patchLink(row.key, { secret })}
                        isDisabled={pending}
                        isInvalid={Boolean(secretIssue) || credentialsFailed}
                      >
                        <Label>{t("builder.linkSecret", { type: row.auth })}</Label>
                        <Input type="password" autoComplete="off" spellCheck={false} />
                        {credentialsFailed ? (
                          <FieldError>{tError("code", { code: "MCP_BUILDER_FETCH_AUTH" })}</FieldError>
                        ) : secretIssue ? (
                          <FieldError>{t("builder.linkSecretIssue")}</FieldError>
                        ) : (
                          <Description>{t("builder.linkSecretHint")}</Description>
                        )}
                      </TextField>
                    </div>
                  ) : null}
                  <Switch isSelected={row.crawl} onChange={(crawl) => patchLink(row.key, { crawl })} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("builder.linkCrawl")}</Label>
                    </Switch.Content>
                    <Description>{t("builder.linkCrawlHint", { depth: MAX_CRAWL_DEPTH })}</Description>
                  </Switch>
                  <Switch isSelected={row.internal} onChange={(internal) => patchLink(row.key, { internal })} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("builder.linkInternal")}</Label>
                    </Switch.Content>
                    <Description>{t("form.internalHint")}</Description>
                  </Switch>
                  <Fieldset.Actions>
                    <Button size="sm" variant="ghost" onPress={() => removeLink(row.key)} isDisabled={pending}>
                      <Trash2 size={14} aria-hidden />
                      {t("builder.removeLink")}
                    </Button>
                  </Fieldset.Actions>
                </Fieldset>
              </Card.Content>
            </Card>
          );
        })}
      </div>

      <TextField fullWidth value={docs} onChange={editDocs} isDisabled={pending} isInvalid={docsTooLong || Boolean(errors.docs)}>
        <Label>{t("builder.docs")}</Label>
        <TextArea className="min-h-40 font-mono text-xs" />
        {errors.docs ? (
          <FieldError>{tError("code", { code: errors.docs })}</FieldError>
        ) : docsTooLong ? (
          <FieldError>{t("builder.docsLong", { max: MAX_BUILDER_DOCS })}</FieldError>
        ) : (
          <Description>{t("builder.docsHint")}</Description>
        )}
      </TextField>

      <Card
        variant="secondary"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!pending) addFiles(event.dataTransfer.files);
        }}
      >
        <Card.Header>
          <Card.Title>{t("builder.files")}</Card.Title>
          <Card.Description>
            {t("builder.filesHint", {
              count: MAX_BUILDER_FILES,
              size: formatBytes(format, MAX_BUILDER_FILE_BYTES),
              total: formatBytes(format, MAX_BUILDER_UPLOAD_BYTES),
            })}
          </Card.Description>
        </Card.Header>
        {files.length ? (
          <Card.Content>
            <ul className="divide-y divide-border" aria-label={t("builder.fileList")}>
              {files.map((row) => (
                <li key={row.key} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm text-foreground">{row.file.name}</p>
                    <p className="text-xs text-muted">{formatBytes(format, row.file.size)}</p>
                    {errors[row.key] ? <p className="text-xs text-danger">{tError("code", { code: errors[row.key] })}</p> : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={t("builder.removeFile", { name: row.file.name })}
                    onPress={() => removeFile(row.key)}
                    isDisabled={pending}
                  >
                    <Trash2 size={16} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </Card.Content>
        ) : null}
        <Card.Footer>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <Button
            variant="secondary"
            onPress={() => picker.current?.click()}
            isDisabled={pending || files.length >= MAX_BUILDER_FILES}
          >
            <Upload size={16} aria-hidden />
            {t("builder.chooseFiles")}
          </Button>
        </Card.Footer>
      </Card>
    </Fieldset>
  );
}
