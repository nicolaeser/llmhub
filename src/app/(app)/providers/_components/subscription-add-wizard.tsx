"use client";

import { useState } from "react";
import { Button, Card, Modal, Radio, RadioGroup, type useOverlayState } from "@heroui/react";
import { ArrowLeft, ArrowRight, Check, FileJson, KeyRound, Plug } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import SubscriptionBadge from "@/components/console/subscription-badge";
import type { ProviderKindSpec } from "@/types/providers";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { kindIcon } from "@/components/providers/kind-icons";

const STEPS = ["provider", "method", "review"] as const;

type Method = "signin" | "file" | "key";

function methodsFor(spec: ProviderKindSpec | null): Method[] {
  if (!spec) return [];
  return isSignInKind(spec.kind) ? ["signin", "file"] : ["key"];
}

export default function SubscriptionAddWizard({
  state,
  catalog,
  antigravityReady,
  onConnect,
}: {
  state: ReturnType<typeof useOverlayState>;
  catalog: ProviderKindSpec[];
  antigravityReady: boolean | null;
  onConnect: (spec: ProviderKindSpec) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<ProviderKindSpec | null>(null);
  const [method, setMethod] = useState<Method>("signin");

  function close() {
    state.close();
    setStep(0);
    setPicked(null);
  }

  function choose(spec: ProviderKindSpec) {
    setPicked(spec);
    setMethod(methodsFor(spec)[0] ?? "key");
    setStep(1);
  }

  function connect() {
    if (!picked) return;
    const spec = picked;
    close();
    onConnect(spec);
  }

  const methods = methodsFor(picked);
  const canNext = step === 0 ? picked !== null : true;
  const last = step === STEPS.length - 1;

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            {() => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("wizard.title")}</Modal.Heading>
                  <p className="text-sm text-muted">{t("wizard.hint")}</p>
                  <ol className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center" aria-label={t("wizard.stepsLabel")}>
                    {STEPS.map((id, index) => {
                      const active = index === step;
                      const done = index < step;
                      return (
                        <li key={id} className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            aria-hidden
                            className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                              done
                                ? "bg-success text-success-foreground"
                                : active
                                  ? "bg-accent text-accent-foreground"
                                  : "bg-default text-muted"
                            }`}
                          >
                            {done ? <Check size={12} aria-hidden /> : index + 1}
                          </span>
                          <span className={`truncate text-xs font-medium ${active ? "text-foreground" : "text-muted"}`}>
                            {t("wizard.step", { step: id })}
                          </span>
                          {index < STEPS.length - 1 ? <span aria-hidden className="hidden h-px flex-1 bg-border sm:block" /> : null}
                        </li>
                      );
                    })}
                  </ol>
                </Modal.Header>
                <Modal.Body>
                  {step === 0 ? (
                    <RadioGroup
                      value={picked?.kind ?? ""}
                      onChange={(value) => {
                        const spec = catalog.find((item) => item.kind === value);
                        if (spec) choose(spec);
                      }}
                      aria-label={t("wizard.providerLabel")}
                      className="grid gap-2 sm:grid-cols-2"
                    >
                      {catalog.map((spec) => {
                        const selected = picked?.kind === spec.kind;
                        const locked = spec.kind === "antigravity" && antigravityReady === false;
                        return (
                          <Card
                            key={spec.kind}
                            variant="secondary"
                            className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
                          >
                            <Radio value={spec.kind} isDisabled={locked} className="mt-0 h-full w-full">
                              <Radio.Content className="h-full w-full items-start gap-3 p-3">
                                <IconTile icon={kindIcon(spec.kind)} tone={selected ? "accent" : "neutral"} />
                                <span className="min-w-0 flex-1">
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate text-sm font-medium">
                                      {tProviders("kindShort", { kind: spec.kind })}
                                    </span>
                                    <SubscriptionBadge />
                                  </span>
                                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
                                    {tProviders("kindDescription", { kind: spec.kind })}
                                  </span>
                                  {locked ? (
                                    <span className="mt-1 block text-xs text-warning">{t("wizard.antigravityLocked")}</span>
                                  ) : null}
                                </span>
                                <Radio.Control>
                                  <Radio.Indicator />
                                </Radio.Control>
                              </Radio.Content>
                            </Radio>
                          </Card>
                        );
                      })}
                    </RadioGroup>
                  ) : null}

                  {step === 1 && picked ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-3 rounded-xl border border-border p-3">
                        <IconTile icon={kindIcon(picked.kind)} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{tProviders("kindShort", { kind: picked.kind })}</p>
                          <p className="truncate text-xs text-muted">{tProviders("channel", { kind: picked.kind })}</p>
                        </div>
                      </div>
                      <RadioGroup
                        value={method}
                        onChange={(value) => setMethod(value as Method)}
                        aria-label={t("wizard.methodLabel")}
                        className="grid gap-2 sm:grid-cols-2"
                      >
                        {methods.includes("signin") ? (
                          <Card variant="secondary" className={method === "signin" ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}>
                            <Radio value="signin" className="mt-0 h-full w-full">
                              <Radio.Content className="h-full w-full items-start gap-3 p-3">
                                <IconTile icon={Plug} tone={method === "signin" ? "accent" : "neutral"} />
                                <span>
                                  <span className="block text-sm font-medium">{t("wizard.methodSignin")}</span>
                                  <span className="mt-0.5 block text-xs text-muted">{t("wizard.methodSigninHint")}</span>
                                </span>
                                <Radio.Control><Radio.Indicator /></Radio.Control>
                              </Radio.Content>
                            </Radio>
                          </Card>
                        ) : null}
                        {methods.includes("file") ? (
                          <Card variant="secondary" className={method === "file" ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}>
                            <Radio value="file" className="mt-0 h-full w-full">
                              <Radio.Content className="h-full w-full items-start gap-3 p-3">
                                <IconTile icon={FileJson} tone={method === "file" ? "accent" : "neutral"} />
                                <span>
                                  <span className="block text-sm font-medium">{t("wizard.methodFile")}</span>
                                  <span className="mt-0.5 block text-xs text-muted">{t("wizard.methodFileHint")}</span>
                                </span>
                                <Radio.Control><Radio.Indicator /></Radio.Control>
                              </Radio.Content>
                            </Radio>
                          </Card>
                        ) : null}
                        {methods.includes("key") ? (
                          <Card variant="secondary" className={method === "key" ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}>
                            <Radio value="key" className="mt-0 h-full w-full">
                              <Radio.Content className="h-full w-full items-start gap-3 p-3">
                                <IconTile icon={KeyRound} tone={method === "key" ? "accent" : "neutral"} />
                                <span>
                                  <span className="block text-sm font-medium">{t("wizard.methodKey")}</span>
                                  <span className="mt-0.5 block text-xs text-muted">{t("wizard.methodKeyHint")}</span>
                                </span>
                                <Radio.Control><Radio.Indicator /></Radio.Control>
                              </Radio.Content>
                            </Radio>
                          </Card>
                        ) : null}
                      </RadioGroup>
                    </div>
                  ) : null}

                  {step === 2 && picked ? (
                    <Card variant="secondary" className="gap-2">
                      <div className="flex items-center gap-3">
                        <IconTile icon={kindIcon(picked.kind)} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{tProviders("kindShort", { kind: picked.kind })}</p>
                          <p className="text-xs text-muted">{t("wizard.reviewMethod", { method })}</p>
                        </div>
                      </div>
                      <p className="text-sm text-muted">{t("wizard.reviewHint")}</p>
                    </Card>
                  ) : null}
                </Modal.Body>
                <Modal.Footer className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                  <div className="flex w-full gap-2 sm:w-auto">
                    <Button variant="tertiary" onPress={close} className="flex-1 sm:flex-none">
                      {tCommon("cancel")}
                    </Button>
                    {step > 0 ? (
                      <Button variant="secondary" onPress={() => setStep((s) => s - 1)} className="flex-1 sm:flex-none">
                        <ArrowLeft size={14} aria-hidden />
                        {tCommon("back")}
                      </Button>
                    ) : null}
                  </div>
                  {last ? (
                    <Button onPress={connect} isDisabled={!canNext} className="w-full sm:w-auto">
                      <Check size={14} aria-hidden />
                      {t("wizard.connect")}
                    </Button>
                  ) : step > 0 ? (
                    <Button onPress={() => setStep((s) => s + 1)} isDisabled={!canNext} className="w-full sm:w-auto">
                      {tCommon("continue")}
                      <ArrowRight size={14} aria-hidden />
                    </Button>
                  ) : null}
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
