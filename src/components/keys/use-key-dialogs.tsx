"use client";

import { useState, useTransition } from "react";
import { Alert, Button, toast, useOverlayState } from "@heroui/react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import CopyButton from "@/components/console/copy-button";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import type {
  IssuedKey,
  KeyCreateInput,
  KeyOptions,
  KeyPreset,
  KeyUpdateInput,
  VirtualKeyView,
} from "@/types/keys";
import type { McpKeyAccess, McpKeyAccessChoice } from "@/types/mcp";
import KeyDialog from "./key-dialog";
import KeyMcpDialog from "./key-mcp-dialog";

export type KeyServerActions = {
  create: (input: KeyCreateInput) => Promise<{ key: IssuedKey } | ActionFail>;
  update: (input: KeyUpdateInput) => Promise<{ key: VirtualKeyView } | ActionFail>;
  rotate: (id: string) => Promise<{ key: IssuedKey } | ActionFail>;
  revoke: (id: string) => Promise<{ id: string } | ActionFail>;
  loadMcp: (keyId: string) => Promise<McpKeyAccess | ActionFail>;
  saveMcp: (input: { keyId: string; servers: McpKeyAccessChoice[] }) => Promise<McpKeyAccess | ActionFail>;
};

export type KeyTarget = { id: string; name: string };

export type KeyChange = "created" | "updated" | "rotated";

type KeyForm = { editing: VirtualKeyView | null; preset: KeyPreset | null; options: KeyOptions };

const NO_OPTIONS: KeyOptions = {
  companyId: "",
  orgs: [],
  teams: [],
  projects: [],
  members: [],
  models: [],
  templates: [],
  canTemplates: false,
};

export function useKeyDialogs({
  actions,
  canBind,
  onSaved,
  onRevoked,
}: {
  actions: KeyServerActions;
  canBind: boolean;
  onSaved: (key: VirtualKeyView, change: KeyChange) => void;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations("Keys");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [form, setForm] = useState<KeyForm | null>(null);
  const [target, setTarget] = useState<KeyTarget | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: "rotate" | "revoke" } | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [, start] = useTransition();
  const keyState = useOverlayState();
  const mcpState = useOverlayState();
  const rotateState = useOverlayState();
  const revokeState = useOverlayState();

  function openForm(next: KeyForm) {
    setForm(next);
    setDialogKey((n) => n + 1);
    keyState.open();
  }

  function openTarget(next: KeyTarget, state: ReturnType<typeof useOverlayState>) {
    setTarget(next);
    setDialogKey((n) => n + 1);
    state.open();
  }

  function rotate(key: KeyTarget) {
    setBusy({ id: key.id, action: "rotate" });
    start(async () => {
      const result = await actions.rotate(key.id);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      const { key: value, ...row } = result.key;
      onSaved(row, "rotated");
      setSecret({ name: key.name, value });
      toast(t("toasts.rotated"), { variant: "success" });
    });
  }

  function revoke(key: KeyTarget) {
    setBusy({ id: key.id, action: "revoke" });
    start(async () => {
      const result = await actions.revoke(key.id);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setSecret(null);
      onRevoked(result.id);
      toast(t("toasts.revoked"), { variant: "success" });
    });
  }

  const notice = secret ? (
    <Alert status="success">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{t("secretTitle", { name: secret.name })}</Alert.Title>
        <Alert.Description>
          {t("secretHint")}
          <code className="mt-2 block break-all font-mono text-sm text-foreground">{secret.value}</code>
        </Alert.Description>
      </Alert.Content>
      <div className="flex shrink-0 items-start gap-1">
        <CopyButton text={secret.value} label={t("copySecret")} />
        <Button isIconOnly size="sm" variant="ghost" aria-label={t("secretDismiss")} onPress={() => setSecret(null)}>
          <X size={14} aria-hidden />
        </Button>
      </div>
    </Alert>
  ) : null;

  const dialogs = (
    <>
      <KeyDialog
        key={`key-${dialogKey}`}
        state={keyState}
        editing={form?.editing ?? null}
        preset={form?.preset ?? null}
        options={form?.options ?? NO_OPTIONS}
        canBind={canBind}
        onCreate={actions.create}
        onUpdate={actions.update}
        onSaved={(row, created) => {
          onSaved(row, created ? "created" : "updated");
          if (created) setSecret({ name: row.key_alias || row.key_name, value: created });
        }}
      />
      <KeyMcpDialog
        key={`mcp-${dialogKey}`}
        state={mcpState}
        keyId={mcpState.isOpen ? (target?.id ?? null) : null}
        keyName={target?.name ?? ""}
        onLoad={actions.loadMcp}
        onSave={actions.saveMcp}
      />
      <ConfirmDialog
        state={rotateState}
        title={t("rotateConfirm.title", { name: target?.name ?? "" })}
        description={t("rotateConfirm.description")}
        confirmLabel={t("rotate")}
        cancelLabel={tCommon("cancel")}
        onConfirm={() => {
          if (target) rotate(target);
        }}
      />
      <ConfirmDialog
        state={revokeState}
        title={t("revokeConfirm.title", { name: target?.name ?? "" })}
        description={t("revokeConfirm.description")}
        confirmLabel={t("revoke")}
        cancelLabel={tCommon("cancel")}
        onConfirm={() => {
          if (target) revoke(target);
        }}
      />
    </>
  );

  return {
    busy,
    notice,
    dialogs,
    openCreate: (options: KeyOptions, preset: KeyPreset | null) => openForm({ editing: null, preset, options }),
    openEdit: (options: KeyOptions, key: VirtualKeyView) => openForm({ editing: key, preset: null, options }),
    openMcp: (key: KeyTarget) => openTarget(key, mcpState),
    askRotate: (key: KeyTarget) => openTarget(key, rotateState),
    askRevoke: (key: KeyTarget) => openTarget(key, revokeState),
  };
}
