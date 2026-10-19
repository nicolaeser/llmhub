"use client";

import { useRef, useState, useTransition } from "react";
import { Alert, Button, Card, Chip, type useOverlayState } from "@heroui/react";
import { FileJson, Upload, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { PlanBadge } from "@/components/console/subscription-badge";
import { isActionFail } from "@/lib/http/action-result";
import { formatBytes } from "@/lib/utils/bytes";
import { MAX_AUTH_FILE_BYTES, MAX_AUTH_FILES } from "@/schemas/providers";
import type { AuthFileResult, AuthFileStatus, AuthFileUpload, ProviderView } from "@/types/providers";
import { importAuthFilesAction } from "../_action";

const BATCH_BYTES = 400 * 1024;

const STATUS_COLOR = {
  created: "success",
  updated: "accent",
  failed: "danger",
} as const satisfies Record<AuthFileStatus, "success" | "accent" | "danger">;

type ImportStep = { failed: AuthFileResult } | { batch: File[] };

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

export default function AuthFilesDialog({
  state,
  onImported,
}: {
  state: ReturnType<typeof useOverlayState>;
  onImported: (providers: ProviderView[]) => void;
}) {
  const t = useTranslations("Subscriptions.importFiles");
  const tCommon = useTranslations("Common");
  const tProviders = useTranslations("Providers");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<AuthFileResult[] | null>(null);
  const [pending, start] = useTransition();
  const picker = useRef<HTMLInputElement>(null);
  const tooMany = files.length > MAX_AUTH_FILES;

  function addFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    setFiles((current) => {
      const known = new Set(current.map(fileKey));
      return [...current, ...picked.filter((file) => !known.has(fileKey(file)))];
    });
  }

  function submit() {
    start(async () => {
      const collected: AuthFileResult[] = [];
      const providers = new Map<string, ProviderView>();
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
      }
      setResults(collected);
      if (providers.size) onImported([...providers.values()]);
    });
  }

  const count = (status: AuthFileStatus) => (results ?? []).filter((item) => item.status === status).length;
  const failed = count("failed");
  const outcome = failed === 0 ? "success" : failed === results?.length ? "failure" : "partial";

  return (
    <FormDialog
      state={state}
      size="md"
      title={t("title")}
      description={t("description")}
      submitLabel={results ? tCommon("done") : t("submit", { count: files.length })}
      submitIcon={results ? undefined : <Upload size={16} aria-hidden />}
      pending={pending}
      isSubmitDisabled={!results && (files.length === 0 || tooMany)}
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
        <>
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
              <Card.Description>
                {t("pickHint", { max: MAX_AUTH_FILES, size: formatBytes(format, MAX_AUTH_FILE_BYTES) })}
              </Card.Description>
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
        </>
      )}
    </FormDialog>
  );
}
