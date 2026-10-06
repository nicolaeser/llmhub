"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Fieldset,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Surface,
  TextField,
  toast,
  useOverlayState,
} from "@heroui/react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { PERMISSION_KEYS } from "@/components/security/permission-keys";
import {
  SecondFactorInput,
  emptySecondFactor,
  secondFactorComplete,
} from "@/components/security/second-factor-input";
import { useSecurityError } from "@/components/security/use-security-error";
import { isActionFail } from "@/lib/http/action-result";
import type { Permission } from "@/types/auth";
import type { ManagementKeysPayload } from "@/types/management";
import type { SecondFactorProof } from "@/types/security";
import { createManagementKeyAction, revokeManagementKeyAction } from "../_action";

const EXPIRY_DAYS = [30, 90, 365, 0] as const;

export default function ManagementKeysCard({
  payload,
  onChange,
}: {
  payload: ManagementKeysPayload;
  onChange: (payload: ManagementKeysPayload) => void;
}) {
  const t = useTranslations("Account.managementKeys");
  const tRoles = useTranslations("Roles");
  const tCommon = useTranslations("Common");
  const tSecurity = useTranslations("Security");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const errorText = useSecurityError();
  const createModal = useOverlayState();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Permission[]>([]);
  const [days, setDays] = useState<number>(90);
  const [proof, setProof] = useState<SecondFactorProof>(emptySecondFactor);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();
  const [revoking, startRevoking] = useTransition();

  function openCreate() {
    setName(t("defaultName"));
    setSelected(payload.grantable.filter((permission) => permission.endsWith(":read")));
    setDays(90);
    setProof(emptySecondFactor);
    setError(null);
    createModal.open();
  }

  function create() {
    setError(null);
    startCreating(async () => {
      const result = await createManagementKeyAction({
        name,
        permissions: selected,
        days,
        code: proof.code,
      });
      if (isActionFail(result)) {
        setError(result.error);
        setProof((current) => ({ ...current, code: "" }));
        return;
      }
      const { secret: issued, ...next } = result;
      onChange(next);
      setSecret(issued);
      createModal.close();
      toast(t("created"), { variant: "success" });
    });
  }

  function revoke(id: string) {
    startRevoking(async () => {
      const result = await revokeManagementKeyAction(id);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onChange(result);
      toast(t("revoked"), { variant: "success" });
    });
  }

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Card.Header className="min-w-0">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description", { path: "/api" })}</Card.Description>
        </Card.Header>
        {payload.grantable.length ? (
          <Button size="sm" variant="secondary" onPress={openCreate}>
            <Plus size={14} aria-hidden />
            {t("create")}
          </Button>
        ) : null}
      </div>
      {payload.grantable.length ? null : <p className="text-sm text-muted">{t("none")}</p>}
      {secret ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("secretTitle")}</Alert.Title>
            <Alert.Description>{t("secretHint", { path: "/api" })}</Alert.Description>
            <div className="mt-2 flex min-w-0 items-start gap-2">
              <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                <code className="font-mono text-sm break-all">{secret}</code>
              </Surface>
              <Button
                isIconOnly
                size="sm"
                variant="secondary"
                aria-label={t("copy")}
                onPress={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    toast(tSecurity("copied"), { variant: "success" });
                  } catch {
                    toast.danger(tSecurity("copyFailed"));
                  }
                }}
              >
                <Copy size={14} aria-hidden />
              </Button>
            </div>
          </Alert.Content>
        </Alert>
      ) : null}
      {payload.keys.length ? (
        <ul className="divide-y divide-border">
          {payload.keys.map((key) => {
            const expired = key.expiresAt ? new Date(key.expiresAt).getTime() <= now.getTime() : false;
            return (
              <li key={key.id} className="flex flex-wrap items-center gap-3 py-3">
                <KeyRound size={16} aria-hidden className="text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  <p className="flex flex-wrap gap-x-2 text-xs text-muted">
                    <code className="font-mono whitespace-nowrap">{key.prefix}…</code>
                    <span>
                      {key.lastUsedAt
                        ? t("lastUsed", { when: format.relativeTime(new Date(key.lastUsedAt), now) })
                        : t("neverUsed")}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {expired
                      ? t("expired")
                      : key.expiresAt
                        ? t("expires", {
                            date: format.dateTime(new Date(key.expiresAt), { dateStyle: "medium" }),
                          })
                        : t("neverExpires")}
                  </p>
                </div>
                <Chip size="sm" variant="soft" color={expired ? "danger" : "default"}>
                  {t("scope", { count: key.permissions.length })}
                </Chip>
                <ConfirmDialog
                  title={t("revokeTitle", { name: key.name })}
                  description={t("revokeDescription")}
                  confirmLabel={t("revoke")}
                  cancelLabel={tCommon("cancel")}
                  pending={revoking}
                  onConfirm={() => revoke(key.id)}
                >
                  <Button isIconOnly size="sm" variant="ghost" aria-label={t("revokeLabel", { name: key.name })}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </ConfirmDialog>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}

      <Modal state={createModal}>
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog className="max-w-lg">
              <Modal.Header>
                <Modal.Heading>{t("create")}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                <p className="text-sm text-muted">{t("createHint")}</p>
                <TextField fullWidth value={name} onChange={setName} isDisabled={creating} maxLength={80}>
                  <Label>{t("name")}</Label>
                  <Input />
                </TextField>
                <Fieldset className="gap-2">
                  <Fieldset.Legend>{t("permissions")}</Fieldset.Legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {payload.grantable.map((permission) => (
                      <Checkbox
                        key={permission}
                        isSelected={selected.includes(permission)}
                        isDisabled={creating}
                        onChange={(checked) =>
                          setSelected((current) =>
                            checked ? [...current, permission] : current.filter((item) => item !== permission),
                          )
                        }
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <span className="text-sm">{tRoles(`permissions.${PERMISSION_KEYS[permission]}.label`)}</span>
                        </Checkbox.Content>
                      </Checkbox>
                    ))}
                  </div>
                </Fieldset>
                <Select
                  selectedKey={String(days)}
                  onSelectionChange={(key) => setDays(Number(key))}
                  isDisabled={creating}
                  fullWidth
                >
                  <Label>{t("expiry")}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label={t("expiry")}>
                      {EXPIRY_DAYS.map((option) => (
                        <ListBox.Item
                          key={option}
                          id={String(option)}
                          textValue={t("expiryOption", { days: option })}
                        >
                          {t("expiryOption", { days: option })}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <SecondFactorInput
                  value={proof}
                  onChange={(next) => {
                    setProof(next);
                    setError(null);
                  }}
                  isDisabled={creating}
                  isInvalid={Boolean(error)}
                  label={t("stepUpLabel")}
                />
                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Description>{errorText(error)}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" isDisabled={creating} onPress={createModal.close}>
                  {tCommon("cancel")}
                </Button>
                <Button
                  isPending={creating}
                  isDisabled={!name.trim() || !selected.length || !secondFactorComplete(proof)}
                  onPress={create}
                >
                  {({ isPending }) => (
                    <>
                      {isPending ? <Spinner color="current" size="sm" /> : <KeyRound size={16} aria-hidden />}
                      {t("create")}
                    </>
                  )}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </Card>
  );
}
