"use client";

import { useRef, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  FieldError,
  Input,
  Label,
  Switch,
  Tabs,
  TextArea,
  TextField,
  type useOverlayState,
} from "@heroui/react";
import { ClipboardPaste, FileJson, Server, Upload, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { PlanBadge } from "@/components/console/subscription-badge";
import { isActionFail } from "@/lib/http/action-result";
import { formatBytes } from "@/lib/utils/bytes";
import { MAX_AUTH_FILE_BYTES, MAX_AUTH_FILES } from "@/schemas/providers";
import type {
  AuthFileResult,
  AuthFileStatus,
  AuthFileUpload,
  CliProxyAuthFile,
  CliProxyListing,
  ProviderView,
} from "@/types/providers";
import { importAuthFilesAction, importCliProxyAuthFilesAction, listCliProxyAuthFilesAction } from "../_action";

const BATCH_BYTES = 400 * 1024;
const SOURCES = ["files", "paste", "server"] as const;

type Source = (typeof SOURCES)[number];

const SOURCE_ICONS = { files: FileJson, paste: ClipboardPaste, server: Server } as const satisfies Record<Source, unknown>;

const STATUS_COLOR = {
  created: "success",
  updated: "accent",
  failed: "danger",
} as const satisfies Record<AuthFileStatus, "success" | "accent" | "danger">;

type ImportStep = { failed: AuthFileResult } | { batch: File[] };

type SourceCleanup = { requested: boolean; removed: number; kept: number };

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function importSteps(files: File[]): ImportStep[] {
  const steps: ImportStep[] = [];
  let batch: File[] = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) steps.push({ batch });
    batch = [];
    bytes = 0;
  };
  for (const file of files) {
    if (file.size > MAX_AUTH_FILE_BYTES) {
      flush();
      steps.push({ failed: { file: file.name, status: "failed", error: "AUTH_FILE_TOO_LARGE" } });
      continue;
    }
    if (batch.length && bytes + file.size > BATCH_BYTES) flush();
    batch.push(file);
    bytes += file.size;
  }
  flush();
  return steps;
}

async function uploadOf(file: File): Promise<AuthFileUpload> {
  return { name: file.name, content: await file.text().catch(() => "") };
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export default function AuthFilesDialog({
  state,
  onImported,
}: {
  state: ReturnType<typeof useOverlayState>;
  onImported: (providers: ProviderView[], superseded: string[]) => void;
}) {
  const t = useTranslations("Subscriptions.importFiles");
  const tCommon = useTranslations("Common");
  const tProviders = useTranslations("Providers");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const [source, setSource] = useState<Source>("files");
  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState("");
  const [server, setServer] = useState({ url: "", key: "" });
  const [listing, setListing] = useState<CliProxyListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [removeAtSource, setRemoveAtSource] = useState(true);
  const [results, setResults] = useState<AuthFileResult[] | null>(null);
  const [cleanup, setCleanup] = useState<SourceCleanup | null>(null);
  const [pending, start] = useTransition();
  const picker = useRef<HTMLInputElement>(null);
  const tooMany = files.length > MAX_AUTH_FILES;
  const pasteTooLarge = textBytes(pasted) > MAX_AUTH_FILE_BYTES;
  const maxSize = formatBytes(format, MAX_AUTH_FILE_BYTES);

  function addFiles(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    setFiles((current) => {
      const known = new Set(current.map(fileKey));
      return [...current, ...chosen.filter((file) => !known.has(fileKey(file)))];
    });
  }

  function finish(collected: AuthFileResult[], providers: ProviderView[], superseded: string[]) {
    setResults(collected);
    if (providers.length || superseded.length) onImported(providers, superseded);
  }

  function importFiles() {
    start(async () => {
      const collected: AuthFileResult[] = [];
      const providers = new Map<string, ProviderView>();
      const superseded = new Set<string>();
      for (const step of importSteps(files)) {
        if ("failed" in step) {
          collected.push(step.failed);
          continue;
        }
        const result = await importAuthFilesAction(await Promise.all(step.batch.map(uploadOf)));
        if (isActionFail(result)) {
          collected.push(...step.batch.map((file): AuthFileResult => ({ file: file.name, status: "failed", error: result.error })));
          continue;
        }
        collected.push(...result.results);
        for (const provider of result.providers) providers.set(provider.id, provider);
        for (const id of result.superseded) {
          superseded.add(id);
          providers.delete(id);
        }
      }
      finish(collected, [...providers.values()], [...superseded]);
    });
  }

  function importPasted() {
    const name = t("pastedName");
    start(async () => {
      const result = await importAuthFilesAction([{ name, content: pasted }]);
      if (isActionFail(result)) {
        finish([{ file: name, status: "failed", error: result.error }], [], []);
        return;
      }
      finish(result.results, result.providers, result.superseded);
    });
  }

  function loadServer() {
    start(async () => {
      const result = await listCliProxyAuthFilesAction(server);
      if (isActionFail(result)) {
        setListError(result.error);
        return;
      }
      setListError(null);
      setListing(result);
      setPicked(result.files.filter((file) => file.importable).map((file) => file.name));
    });
  }

  function importServer() {
    start(async () => {
      const result = await importCliProxyAuthFilesAction({ ...server, names: picked, removeFromSource: removeAtSource });
      if (isActionFail(result)) {
        setListError(result.error);
        return;
      }
      setCleanup({ requested: removeAtSource, removed: result.removed.length, kept: result.keptAtSource.length });
      finish(result.results, result.providers, result.superseded);
    });
  }

  function submit() {
    if (source === "files") importFiles();
    else if (source === "paste") importPasted();
    else if (listing) importServer();
    else loadServer();
  }

  function changeServer() {
    setListing(null);
    setPicked([]);
    setListError(null);
  }

  const submitLabel = results
    ? tCommon("done")
    : source === "files"
      ? t("submit", { count: files.length })
      : source === "paste"
        ? t("submitPaste")
        : listing
          ? t("submitServer", { count: picked.length })
          : t("loadServer");
  const submitDisabled =
    !results &&
    (source === "files"
      ? files.length === 0 || tooMany
      : source === "paste"
        ? !pasted.trim() || pasteTooLarge
        : listing
          ? picked.length === 0
          : !server.url.trim() || !server.key.trim());

  const count = (status: AuthFileStatus) => (results ?? []).filter((item) => item.status === status).length;
  const failed = count("failed");
  const outcome = failed === 0 ? "success" : failed === results?.length ? "failure" : "partial";

  function kindLabel(file: CliProxyAuthFile): string {
    return file.kind ? tProviders("kindShort", { kind: file.kind }) : file.type || t("unknownType");
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("title")}
      description={t("description")}
      submitLabel={submitLabel}
      submitIcon={results ? undefined : source === "server" && !listing ? <Server size={16} aria-hidden /> : <Upload size={16} aria-hidden />}
      pending={pending}
      isSubmitDisabled={submitDisabled}
      onSubmit={(close) => (results ? close() : submit())}
    >
      {results ? (
        <section aria-label={t("results")} className="space-y-3">
          <Alert status={outcome === "success" ? "success" : outcome === "partial" ? "warning" : "danger"}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t("summary", { outcome })}</Alert.Title>
              <Alert.Description>
                {t("counts", { created: count("created"), updated: count("updated"), failed })}
              </Alert.Description>
            </Alert.Content>
          </Alert>
          {cleanup && count("created") + count("updated") > 0 ? (
            <Alert status={!cleanup.requested || cleanup.kept ? "warning" : "success"}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  {cleanup.requested
                    ? cleanup.kept
                      ? t("keptAtSource", { count: cleanup.kept })
                      : t("moved", { removed: cleanup.removed })
                    : t("rotation")}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
          <ul className="max-h-72 divide-y divide-border overflow-y-auto" aria-live="polite">
            {results.map((item, index) => (
              <li key={`${item.file}-${index}`} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1 basis-48 space-y-1">
                  <p className="break-all text-foreground">{item.file}</p>
                  {item.kind ? (
                    <p className="break-words text-xs text-muted">
                      {t("entry", {
                        kind: tProviders("kindShort", { kind: item.kind }),
                        named: item.account ? "true" : "false",
                        account: item.account ?? "",
                      })}
                    </p>
                  ) : null}
                  {item.error ? <p className="text-xs text-danger">{tError("code", { code: item.error })}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <PlanBadge plan={item.plan ?? ""} />
                  <Chip size="sm" variant="soft" color={STATUS_COLOR[item.status]} className="whitespace-nowrap">
                    {t("status", { status: item.status })}
                  </Chip>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Tabs selectedKey={source} onSelectionChange={(key) => setSource(SOURCES.find((item) => item === key) ?? "files")} isDisabled={pending}>
          <Tabs.List className="w-full flex-wrap" aria-label={t("sourcesLabel")}>
            {SOURCES.map((id) => {
              const Icon = SOURCE_ICONS[id];
              return (
                <Tabs.Tab key={id} id={id} className="w-auto gap-2 whitespace-nowrap">
                  <Icon size={14} aria-hidden />
                  {t("source", { source: id })}
                  <Tabs.Indicator />
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
          <Tabs.Panel id="files" className="space-y-4 pt-4">
            <Card
              variant="secondary"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!pending) addFiles(event.dataTransfer.files);
              }}
            >
              <Card.Header>
                <Card.Title>{t("pickTitle")}</Card.Title>
                <Card.Description>{t("pickHint", { max: MAX_AUTH_FILES, size: maxSize })}</Card.Description>
              </Card.Header>
              <Card.Footer className="flex-wrap gap-2">
                <input
                  ref={picker}
                  type="file"
                  multiple
                  accept=".json,application/json"
                  tabIndex={-1}
                  aria-hidden
                  className="sr-only"
                  onChange={(event) => {
                    addFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
                <Button variant="secondary" isDisabled={pending} onPress={() => picker.current?.click()}>
                  <FileJson size={16} aria-hidden />
                  {t("choose")}
                </Button>
                {files.length ? (
                  <Button variant="ghost" isDisabled={pending} onPress={() => setFiles([])}>
                    {t("clear")}
                  </Button>
                ) : null}
              </Card.Footer>
            </Card>
            {files.length ? (
              <section aria-label={t("chosen", { count: files.length })} className="space-y-2">
                <p className="text-sm font-medium text-foreground">{t("chosen", { count: files.length })}</p>
                <ul className="max-h-60 divide-y divide-border overflow-y-auto">
                  {files.map((file) => (
                    <li key={fileKey(file)} className="flex items-center justify-between gap-2 py-1 text-sm">
                      <span className="min-w-0 break-all text-foreground">{file.name}</span>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={t("remove", { name: file.name })}
                        isDisabled={pending}
                        onPress={() => setFiles((current) => current.filter((item) => fileKey(item) !== fileKey(file)))}
                      >
                        <X size={14} aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
                {tooMany ? <p className="text-sm text-danger">{t("tooMany", { max: MAX_AUTH_FILES })}</p> : null}
              </section>
            ) : null}
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{t("rotation")}</Alert.Description>
              </Alert.Content>
            </Alert>
          </Tabs.Panel>
          <Tabs.Panel id="paste" className="space-y-4 pt-4">
            <TextField fullWidth value={pasted} onChange={setPasted} isDisabled={pending} isInvalid={pasteTooLarge}>
              <Label>{t("pasteLabel")}</Label>
              <TextArea rows={8} spellCheck={false} autoComplete="off" className="font-mono text-xs" placeholder={t("pastePlaceholder")} />
              <Description>{t("pasteHint", { size: maxSize })}</Description>
              <FieldError>{t("pasteTooLarge", { size: maxSize })}</FieldError>
            </TextField>
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{t("rotation")}</Alert.Description>
              </Alert.Content>
            </Alert>
          </Tabs.Panel>
          <Tabs.Panel id="server" className="space-y-4 pt-4">
            {listing ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-words text-sm text-muted">
                    {t("serverFound", { count: listing.files.length, version: listing.version, hasVersion: listing.version ? "true" : "false" })}
                  </p>
                  <Button size="sm" variant="ghost" isDisabled={pending} onPress={changeServer}>
                    {t("changeServer")}
                  </Button>
                </div>
                {listing.files.length ? (
                  <CheckboxGroup value={picked} onChange={setPicked} isDisabled={pending} className="max-h-72 overflow-y-auto">
                    <Label>{t("serverPick")}</Label>
                    {listing.files.map((file) => (
                      <Checkbox key={file.name} value={file.name} isDisabled={!file.importable}>
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Label className="break-all">{file.name}</Label>
                        </Checkbox.Content>
                        <Description className="flex flex-wrap items-center gap-1">
                          <span className="break-words">
                            {t("entry", { kind: kindLabel(file), named: file.account ? "true" : "false", account: file.account })}
                          </span>
                          {!file.importable ? (
                            <Chip size="sm" variant="soft">
                              {t("serverUnsupported")}
                            </Chip>
                          ) : null}
                          {file.disabled ? (
                            <Chip size="sm" variant="soft" color="warning">
                              {t("serverDisabled")}
                            </Chip>
                          ) : null}
                        </Description>
                      </Checkbox>
                    ))}
                  </CheckboxGroup>
                ) : (
                  <p className="text-sm text-muted">{t("serverEmpty")}</p>
                )}
                <Switch isSelected={removeAtSource} onChange={setRemoveAtSource} isDisabled={pending}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Label>{t("removeAtSource")}</Label>
                  </Switch.Content>
                  <Description>{t("removeAtSourceHint")}</Description>
                </Switch>
                {!removeAtSource ? (
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>{t("rotation")}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </>
            ) : (
              <>
                <TextField
                  fullWidth
                  value={server.url}
                  onChange={(url) => setServer((current) => ({ ...current, url }))}
                  isDisabled={pending}
                >
                  <Label>{t("serverUrl")}</Label>
                  <Input inputMode="url" autoComplete="off" placeholder="http://127.0.0.1:8317" />
                  <Description>{t("serverUrlHint")}</Description>
                </TextField>
                <TextField
                  fullWidth
                  value={server.key}
                  onChange={(key) => setServer((current) => ({ ...current, key }))}
                  isDisabled={pending}
                >
                  <Label>{t("serverKey")}</Label>
                  <Input type="password" autoComplete="off" />
                  <Description>{t("serverKeyHint")}</Description>
                </TextField>
              </>
            )}
            {listError ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{tError("code", { code: listError })}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
          </Tabs.Panel>
        </Tabs>
      )}
    </FormDialog>
  );
}
