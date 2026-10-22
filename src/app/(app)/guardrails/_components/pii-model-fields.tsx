"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Description, Label, NumberField, Spinner, TextArea } from "@heroui/react";
import { ScanSearch } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { internalAliases, modelPickerItem } from "@/components/console/model-test";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { PII_TIMEOUT_MAX_SECONDS, PII_TIMEOUT_MIN_SECONDS } from "@/schemas/guardrails";
import { testPiiModelAction } from "../_action";
import type { PiiDetectorSettings, PiiModelTest } from "@/types/guardrails";
import type { FeatureModelChoice } from "@/types/models";

const SAMPLE =
  "Hi, I'm Daniel Whitfield. Reach me at daniel.whitfield@example.com or +1 415 555 0123.\nIch bin Anna Schneider und wohne in der Hauptstraße 12, 10115 Berlin.";

function redactionChoices(models: readonly FeatureModelChoice[], current: string): FeatureModelChoice[] {
  const matched = models.filter((model) => model.role === "redaction" || model.internal);
  if (!current || matched.some((model) => model.alias === current)) return matched;
  const selected = models.find((model) => model.alias === current);
  return [...matched, selected ?? { alias: current, label: current, role: "redaction", internal: false }];
}

function PiiModelTester({ model }: { model: string }) {
  const t = useTranslations("Guardrails.model");
  const tPii = useTranslations("Guardrails");
  const tTest = useTranslations("Common.modelTest");
  const format = useFormatter();
  const showError = useErrorToast();
  const [sample, setSample] = useState(SAMPLE);
  const [outcome, setOutcome] = useState<{ text: string; model: string; result: PiiModelTest } | null>(null);
  const [pending, start] = useTransition();
  const result = outcome?.model === model ? outcome.result : null;

  function run() {
    const text = sample;
    start(async () => {
      const next = await testPiiModelAction({ model, text });
      if (isActionFail(next)) {
        showError(next.error);
        return;
      }
      setOutcome({ text, model, result: next });
    });
  }

  return (
    <Card variant="tertiary" className="gap-3">
      <Card.Header>
        <Card.Title>{t("tester")}</Card.Title>
        <Card.Description>{t("testerHint")}</Card.Description>
      </Card.Header>
      <TextArea fullWidth value={sample} onChange={(event) => setSample(event.target.value)} aria-label={t("sample")} className="min-h-24" />
      <Button size="sm" variant="secondary" className="self-start" isPending={pending} isDisabled={!model || !sample.trim()} onPress={run}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <ScanSearch size={14} aria-hidden />}
            {t("detect")}
          </>
        )}
      </Button>
      {result && outcome ? (
        <output aria-live="polite" className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <Chip size="sm" variant="soft" color={result.ok ? "success" : "danger"}>
              {tTest("state", { ok: result.ok ? "true" : "false" })}
            </Chip>
            <span className="break-words text-muted">
              {t("result", { count: result.spans.length, ms: result.latencyMs, status: result.status })}
            </span>
            {result.error ? <span className="break-words text-danger">{result.error}</span> : null}
          </div>
          {result.spans.length ? (
            <ul className="flex min-w-0 flex-col gap-2">
              {result.spans.map((span) => (
                <li key={`${span.start}:${span.end}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                  <Chip size="sm" variant="soft">
                    {tPii("entityLabel", { id: span.entity })}
                  </Chip>
                  <span className="min-w-0 break-words">{outcome.text.slice(span.start, span.end)}</span>
                  <span className="text-xs tabular-nums text-muted">{format.number(span.score, "percent")}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </output>
      ) : null}
    </Card>
  );
}

export default function PiiModelFields({
  value,
  onChange,
  models,
  configured,
  canManage,
}: {
  value: PiiDetectorSettings;
  onChange: (next: PiiDetectorSettings) => void;
  models: FeatureModelChoice[];
  configured: boolean;
  canManage: boolean;
}) {
  const t = useTranslations("Guardrails.model");
  const internal = internalAliases(models);

  return (
    <Card variant="secondary" className="gap-4">
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        <SearchSelect
          label={t("label")}
          description={t("hint", { configured: configured ? "true" : "false" })}
          items={[
            { id: "none", label: t("none") },
            ...redactionChoices(models, value.model).map((model) => modelPickerItem(model, internal)),
          ]}
          value={value.model || "none"}
          onChange={(key) => onChange({ ...value, model: key === "none" ? "" : key })}
          isDisabled={!canManage}
        />
        <NumberField
          fullWidth
          value={value.timeout_seconds}
          onChange={(seconds) => onChange({ ...value, timeout_seconds: Number.isFinite(seconds) ? seconds : PII_TIMEOUT_MIN_SECONDS })}
          minValue={PII_TIMEOUT_MIN_SECONDS}
          maxValue={PII_TIMEOUT_MAX_SECONDS}
          step={1}
          formatOptions={formats.number.integer}
          isDisabled={!canManage}
        >
          <Label>{t("timeout")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          <Description>{t("timeoutHint")}</Description>
        </NumberField>
      </div>
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{t("language")}</Alert.Description>
        </Alert.Content>
      </Alert>
      {canManage && value.model ? <PiiModelTester model={value.model} /> : null}
    </Card>
  );
}
