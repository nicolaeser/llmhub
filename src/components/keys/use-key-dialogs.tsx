"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast, useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import type {
  IssuedKey,
  KeyCreateInput,
  KeyOptions,
  KeyPauseInput,
  KeyPreset,
  KeyUpdateInput,
  VirtualKeyView,
} from "@/types/keys";
import type { McpKeyAccess, McpKeyAccessChoice } from "@/types/mcp";
import type { BudgetInput, BudgetResult } from "@/types/structure";
import KeyDialog from "./key-dialog";
import KeyMcpDialog from "./key-mcp-dialog";
import KeyPauseDialog from "./key-pause-dialog";
import KeySecretDialog, { type IssuedSecret } from "./key-secret-dialog";

export type KeyServerActions = {
  create: (input: KeyCreateInput) => Promise<{ key: IssuedKey } | ActionFail>;
  update: (input: KeyUpdateInput) => Promise<{ key: VirtualKeyView } | ActionFail>;
  pause: (input: KeyPauseInput) => Promise<{ key: VirtualKeyView } | ActionFail>;
  resume: (id: string) => Promise<{ key: VirtualKeyView } | ActionFail>;
  rotate: (id: string) => Promise<{ key: IssuedKey } | ActionFail>;
  revoke: (id: string) => Promise<{ id: string } | ActionFail>;
  loadMcp: (keyId: string) => Promise<McpKeyAccess | ActionFail>;
  saveMcp: (input: { keyId: string; servers: McpKeyAccessChoice[] }) => Promise<McpKeyAccess | ActionFail>;
  setBudget?: (input: BudgetInput) => Promise<BudgetResult | ActionFail>;
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
  canBudget = false,
  linkToDetail = true,
  onSaved,
  onRevoked,
}: {
  actions: KeyServerActions;
  canBind: boolean;
  canBudget?: boolean;
  linkToDetail?: boolean;
  onSaved: (key: VirtualKeyView, change: KeyChange) => void;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations("Keys");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [form, setForm] = useState<KeyForm | null>(null);
  const [target, setTarget] = useState<KeyTarget | null>(null);
  const [secret, setSecret] = useState<IssuedSecret | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: "resume" | "rotate" | "revoke" } | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [, start] = useTransition();
  const keyState = useOverlayState();
  const mcpState = useOverlayState();
  const pauseState = useOverlayState();
  const rotateState = useOverlayState();
  const revokeState = useOverlayState();
  const secretState = useOverlayState();

  function reveal(row: VirtualKeyView, value: string, rotated: boolean) {
    setSecret({ id: row.token_id, name: row.key_alias || row.key_name, value, rotated });
    secretState.open();
  }

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

  function resume(key: KeyTarget) {
    setBusy({ id: key.id, action: "resume" });
    start(async () => {
      const result = await actions.resume(key.id);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.key, "updated");
      toast(t("toasts.resumed"), { variant: "success" });
    });
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
      reveal(row, value, true);
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
      onRevoked(result.id);
      toast(t("toasts.revoked"), { variant: "success" });
    });
  }

  const notice: ReactNode = null;

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
        onBudget={canBudget ? actions.setBudget : undefined}
        onSaved={(row, created) => {
          onSaved(row, created ? "created" : "updated");
          if (created) reveal(row, created, false);
        }}
      />
      <KeySecretDialog state={secretState} secret={secret} linkToDetail={linkToDetail} />
      <KeyMcpDialog
        key={`mcp-${dialogKey}`}
        state={mcpState}
        keyId={mcpState.isOpen ? (target?.id ?? null) : null}
        keyName={target?.name ?? ""}
        onLoad={actions.loadMcp}
        onSave={actions.saveMcp}
      />
      <KeyPauseDialog
        key={`pause-${dialogKey}`}
        state={pauseState}
        keyId={target?.id ?? null}
        keyName={target?.name ?? ""}
        onPause={actions.pause}
        onPaused={(row) => onSaved(row, "updated")}
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
    askPause: (key: KeyTarget) => openTarget(key, pauseState),
    resume,
    askRotate: (key: KeyTarget) => openTarget(key, rotateState),
    askRevoke: (key: KeyTarget) => openTarget(key, revokeState),
  };
}
