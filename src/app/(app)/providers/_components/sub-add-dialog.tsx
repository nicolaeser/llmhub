"use client";

import { useId, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Description,
  Fieldset,
  Form,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Separator,
  Spinner,
  Surface,
  Switch,
  TextField,
  toast,
  useOverlayState,
} from "@heroui/react";
import { Check, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import IconTile from "@/components/console/icon-tile";
import { kindIcon } from "@/components/providers/kind-icons";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { isActionFail } from "@/lib/http/action-result";
import { SUB_ADD_DEFAULT_DAYS, SUB_ADD_LABEL_MAX } from "@/schemas/sub-add";
import type { AccessMode, SignInKind } from "@/types/providers";
import type { SubAddCreated } from "@/types/sub-add";
import { createSubAddLinkAction } from "../_action";
import AccessFields, { pickedFrom, pickedTargets, useAssignmentOptions } from "./access-fields";

const DAY_OPTIONS = [1, 3, 7, 14, 30, 60, 90] as const;
const ACCOUNT_OPTIONS = [1, 2, 3, 5, 10, 20, 50, 0] as const;

export default function SubAddDialog({
  state,
  kinds,
  preset,
  antigravityReady,
  onCreated,
}: {
  state: ReturnType<typeof useOverlayState>;
  kinds: SignInKind[];
  preset: SignInKind | null;
  antigravityReady: boolean | null;
  onCreated: (result: SubAddCreated) => void;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const formId = useId();
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<SignInKind[]>(() =>
    preset && kinds.includes(preset) ? [preset] : kinds,
  );
  const [days, setDays] = useState<number>(SUB_ADD_DEFAULT_DAYS);
  const [accounts, setAccounts] = useState<number>(1);
  const [manageable, setManageable] = useState(true);
  const [mode, setMode] = useState<AccessMode>("open");
  const [picked, setPicked] = useState(() => pickedFrom([]));
  const [url, setUrl] = useState<string | null>(null);
  const stepUp = useOverlayState();
  const pending = stepUp.isOpen;
  const options = useAssignmentOptions(state.isOpen && mode === "limited" && url === null);
  const invalid = !label.trim() || selected.length === 0 || (mode === "limited" && options === null);

  function create() {
    if (pending || invalid) return;
    stepUp.open();
  }

  async function createWithCode(code: string): Promise<string | null> {
    const result = await createSubAddLinkAction({
      label,
      kinds: selected,
      days,
      maxAccounts: accounts === 0 ? null : accounts,
      restricted: mode === "limited",
      manageable,
      targets: mode === "limited" ? pickedTargets(picked) : [],
      code,
    });
    if (isActionFail(result)) return result.error;
    onCreated(result);
    setUrl(result.url);
    toast(t("createdToast"), { variant: "success" });
    return null;
  }

  return (
    <>
      <Modal.Backdrop isOpen={state.isOpen} onOpenChange={state.setOpen}>
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            {({ close }) => (
              <>
                <Modal.Header className="flex-row items-start gap-3">
                  <IconTile icon={url ? Check : Link2} tone={url ? "success" : "accent"} />
                  <div className="min-w-0 flex-1">
                    <Modal.Heading>{url ? t("createdTitle") : t("dialogTitle")}</Modal.Heading>
                    <p className="text-sm text-muted">{url ? t("createdDescription", { label }) : t("dialogDescription")}</p>
                  </div>
                </Modal.Header>
                <Modal.Body>
                  {url ? (
                    <div className="space-y-4">
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
                        <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                          <code className="font-mono text-sm break-all">{url}</code>
                        </Surface>
                        <CopyButton text={url} label={t("copy")} />
                      </div>
                      <Alert status="warning">
                        <Alert.Indicator />
                        <Alert.Content className="min-w-0">
                          <Alert.Title>{t("onceTitle")}</Alert.Title>
                          <Alert.Description>{t("createdHint")}</Alert.Description>
                        </Alert.Content>
                      </Alert>
                    </div>
                  ) : (
                    <Form
                      id={formId}
                      className="flex flex-col gap-5"
                      onSubmit={(event) => {
                        event.preventDefault();
                        create();
                      }}
                    >
                      <TextField
                        fullWidth
                        value={label}
                        onChange={setLabel}
                        isDisabled={pending}
                        maxLength={SUB_ADD_LABEL_MAX}
                        isRequired
                      >
                        <Label>{t("label")}</Label>
                        <Input autoComplete="off" />
                        <Description>{t("labelHint")}</Description>
                      </TextField>
                      <Fieldset className="gap-2">
                        <Fieldset.Legend>{t("providers")}</Fieldset.Legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {kinds.map((kind) => (
                            <Checkbox
                              key={kind}
                              isSelected={selected.includes(kind)}
                              isDisabled={pending}
                              onChange={(checked) =>
                                setSelected((current) =>
                                  checked ? [...current, kind] : current.filter((item) => item !== kind),
                                )
                              }
                            >
                              <Checkbox.Content className="items-center gap-2">
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                                <IconTile icon={kindIcon(kind)} tone={selected.includes(kind) ? "accent" : "neutral"} size="sm" />
                                <span className="text-sm">{tProviders("kindShort", { kind })}</span>
                              </Checkbox.Content>
                            </Checkbox>
                          ))}
                        </div>
                        {antigravityReady === false && selected.includes("antigravity") ? (
                          <p className="text-xs text-warning">{t("antigravityHidden")}</p>
                        ) : null}
                      </Fieldset>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Select
                          selectedKey={String(days)}
                          onSelectionChange={(key) => setDays(Number(key))}
                          isDisabled={pending}
                          fullWidth
                        >
                          <Label>{t("validFor")}</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Description>{t("validForHint")}</Description>
                          <Select.Popover>
                            <ListBox aria-label={t("validFor")}>
                              {DAY_OPTIONS.map((option) => (
                                <ListBox.Item key={option} id={String(option)} textValue={t("days", { days: option })}>
                                  {t("days", { days: option })}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                        <Select
                          selectedKey={String(accounts)}
                          onSelectionChange={(key) => setAccounts(Number(key))}
                          isDisabled={pending}
                          fullWidth
                        >
                          <Label>{t("maxAccounts")}</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Description>{t("maxAccountsHint")}</Description>
                          <Select.Popover>
                            <ListBox aria-label={t("maxAccounts")}>
                              {ACCOUNT_OPTIONS.map((option) => (
                                <ListBox.Item key={option} id={String(option)} textValue={t("accountOption", { count: option })}>
                                  {t("accountOption", { count: option })}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      </div>
                      <Switch isSelected={manageable} onChange={setManageable} isDisabled={pending}>
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                          <Label>{t("manageable")}</Label>
                        </Switch.Content>
                        <Description>{t("manageableHint")}</Description>
                      </Switch>
                      <Separator />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">{t("accessTitle")}</p>
                        <p className="text-sm text-muted">{t("accessHint")}</p>
                      </div>
                      <AccessFields
                        mode={mode}
                        onModeChange={setMode}
                        picked={picked}
                        onPickedChange={setPicked}
                        options={options}
                        known={[]}
                        isDisabled={pending}
                      />
                    </Form>
                  )}
                </Modal.Body>
                <Modal.Footer>
                  {url ? (
                    <Button onPress={close}>{tCommon("done")}</Button>
                  ) : (
                    <>
                      <Button variant="tertiary" onPress={close} isDisabled={pending}>
                        {tCommon("cancel")}
                      </Button>
                      <Button type="submit" form={formId} isPending={pending} isDisabled={invalid}>
                        {({ isPending }) => (
                          <>
                            {isPending ? <Spinner color="current" size="sm" /> : <Link2 size={16} aria-hidden />}
                            {t("submit")}
                          </>
                        )}
                      </Button>
                    </>
                  )}
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      <StepUpDialog
        state={stepUp}
        title={t("stepUpTitle")}
        description={t("stepUpDescription")}
        confirmLabel={t("submit")}
        onConfirm={createWithCode}
      />
    </>
  );
}
