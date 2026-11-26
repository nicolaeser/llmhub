"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { Button, Card, Input, Label, Radio, Spinner, Surface, Tabs, TextField } from "@heroui/react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { KEY_PLACEHOLDER, type ConnectShell, type GuideCode } from "./connect-guides";

const noSubscription = () => () => {};

function detectShell(): ConnectShell {
  return /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
}

export function useDetectedShell(): ConnectShell {
  return useSyncExternalStore(noSubscription, detectShell, () => "posix" as const);
}

function downloadJson(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function Section({
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

export function CodeBlock({ code, copyLabel, downloadLabel }: { code: GuideCode; copyLabel: string; downloadLabel: string }) {
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

export function ValueRow({ label, value, hint, copyLabel }: { label: string; value: string; hint?: ReactNode; copyLabel: string }) {
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

export function ToolCard({ id, label, hint, selected }: { id: string; label: string; hint: string; selected: boolean }) {
  return (
    <Card variant="secondary" className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}>
      <Radio value={id} className="mt-0 h-full w-full">
        <Radio.Content className="h-full w-full items-start gap-3 p-3">
          <Radio.Control>
            <Radio.Indicator />
          </Radio.Control>
          <span className="min-w-0 flex-1 space-y-1">
            <Label>{label}</Label>
            <span className="hidden text-xs font-normal text-muted sm:block">{hint}</span>
          </span>
        </Radio.Content>
      </Radio>
    </Card>
  );
}

export function ShellTabs({ shell, onChange }: { shell: ConnectShell; onChange: (shell: ConnectShell) => void }) {
  const t = useTranslations("Connect");
  return (
    <Tabs selectedKey={shell} onSelectionChange={(next) => onChange(next === "windows" ? "windows" : "posix")} className="w-fit">
      <Tabs.List className="w-fit min-w-0" aria-label={t("setup.shell")}>
        {(["posix", "windows"] as const).map((id) => (
          <Tabs.Tab key={id} id={id} className="w-auto">
            {t("setup.shellName", { shell: id })}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}

export function KeyField({
  value,
  onChange,
  checking,
  onCheck,
}: {
  value: string;
  onChange: (value: string) => void;
  checking: boolean;
  onCheck: () => void;
}) {
  const t = useTranslations("Connect");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField fullWidth value={value} onChange={onChange} type="password" className="min-w-0 flex-1 basis-64">
        <Label>{t("access.key")}</Label>
        <Input type="password" autoComplete="off" spellCheck={false} placeholder={KEY_PLACEHOLDER} />
      </TextField>
      <Button variant="secondary" isPending={checking} isDisabled={!value.trim()} onPress={onCheck}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : null}
            {t("access.check")}
          </>
        )}
      </Button>
    </div>
  );
}

export function StepItem({ index, children }: { index: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold text-muted tabular-nums ring-1 ring-border ring-inset"
        aria-hidden
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
    </li>
  );
}
