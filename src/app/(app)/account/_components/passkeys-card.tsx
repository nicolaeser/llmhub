"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Input,
  Label,
  TextField,
  toast,
  useOverlayState,
} from "@heroui/react";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { isActionFail } from "@/lib/http/action-result";
import {
  SecondFactorInput,
  emptySecondFactor,
  secondFactorComplete,
} from "@/components/security/second-factor-input";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { useSecurityError } from "@/components/security/use-security-error";
import {
  PasskeyCancelledError,
  passkeyAttestation,
  usePasskeySupport,
} from "@/components/security/webauthn";
import type { PasskeyView, SecondFactorProof, SecurityOverview } from "@/types/security";
import {
  finishPasskeyRegistrationAction,
  removePasskeyAction,
  renamePasskeyAction,
  startPasskeyRegistrationAction,
} from "../_action";

export default function PasskeysCard({
  passkeys,
  available,
  onChange,
}: {
  passkeys: PasskeyView[];
  available: boolean;
  onChange: (overview: SecurityOverview) => void;
}) {
  const t = useTranslations("Account.passkeys");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const errorText = useSecurityError();
  const browserSupport = usePasskeySupport();
  const addModal = useOverlayState();
  const renameModal = useOverlayState();
  const removeStepUp = useOverlayState();
  const [name, setName] = useState("");
  const [proof, setProof] = useState<SecondFactorProof>(emptySecondFactor);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<PasskeyView | null>(null);
  const [adding, startAdding] = useTransition();
  const [renaming, startRenaming] = useTransition();

  function openAdd() {
    setName(t("defaultName"));
    setProof(emptySecondFactor);
    setError(null);
    addModal.open();
  }

  function add() {
    setError(null);
    startAdding(async () => {
      const options = await startPasskeyRegistrationAction({ code: proof.code });
      if (isActionFail(options)) {
        setError(options.error);
        setProof((current) => ({ ...current, code: "" }));
        return;
      }
      try {
        const response = await passkeyAttestation(options);
        const result = await finishPasskeyRegistrationAction({ name, response });
        if (isActionFail(result)) {
          setError(result.error);
          return;
        }
        onChange(result);
        addModal.close();
        toast(t("added"), { variant: "success" });
      } catch (caught) {
        if (caught instanceof PasskeyCancelledError) {
          setError("PASSKEY_CHALLENGE_EXPIRED");
          return;
        }
        setError("PASSKEY_VERIFICATION_FAILED");
      }
    });
  }

  function rename() {
    if (!target) return;
    startRenaming(async () => {
      const result = await renamePasskeyAction({ id: target.id, name });
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onChange(result);
      renameModal.close();
    });
  }

  const canAdd = available && browserSupport;

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Card.Header className="min-w-0">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </Card.Header>
        {canAdd ? (
          <Button size="sm" variant="secondary" onPress={openAdd}>
            <Plus size={14} aria-hidden />
            {t("add")}
          </Button>
        ) : null}
      </div>
      {!available ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("unavailable")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : !browserSupport ? (
        <p className="text-sm text-muted">{t("unsupported")}</p>
      ) : null}
      {passkeys.length ? (
        <ul className="divide-y divide-border">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex flex-wrap items-center gap-3 py-3">
              <KeyRound size={16} aria-hidden className="text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{passkey.name}</p>
                <p className="text-xs text-muted">
                  {passkey.lastUsedAt
                    ? t("lastUsed", { when: format.relativeTime(new Date(passkey.lastUsedAt), now) })
                    : t("addedOn", {
                        date: format.dateTime(new Date(passkey.createdAt), { dateStyle: "medium" }),
                      })}
                </p>
              </div>
              <Chip size="sm" variant="soft">
                {t("sync", { synced: passkey.backedUp ? "true" : "false" })}
              </Chip>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={t("renameLabel", { name: passkey.name })}
                onPress={() => {
                  setTarget(passkey);
                  setName(passkey.name);
                  renameModal.open();
                }}
              >
                <Pencil size={14} aria-hidden />
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={t("removeLabel", { name: passkey.name })}
                onPress={() => {
                  setTarget(passkey);
                  removeStepUp.open();
                }}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}

      <FormDialog
        state={addModal}
        size="sm"
        title={t("add")}
        description={t("addHint")}
        submitLabel={t("create")}
        submitIcon={<KeyRound size={16} aria-hidden />}
        pending={adding}
        isSubmitDisabled={!name.trim() || !secondFactorComplete(proof)}
        onSubmit={add}
      >
        <TextField fullWidth value={name} onChange={setName} isDisabled={adding} maxLength={64}>
          <Label>{t("name")}</Label>
          <Input />
        </TextField>
        <SecondFactorInput
          value={proof}
          onChange={(next) => {
            setProof(next);
            setError(null);
          }}
          isDisabled={adding}
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
      </FormDialog>

      <FormDialog
        state={renameModal}
        size="sm"
        title={t("rename")}
        submitLabel={tCommon("save")}
        pending={renaming}
        isSubmitDisabled={!name.trim()}
        onSubmit={rename}
      >
        <TextField fullWidth value={name} onChange={setName} isDisabled={renaming} maxLength={64}>
          <Label>{t("name")}</Label>
          <Input />
        </TextField>
      </FormDialog>

      <StepUpDialog
        state={removeStepUp}
        title={t("remove")}
        description={t("removeStepUp", { name: target?.name ?? "" })}
        confirmLabel={t("remove")}
        danger
        onConfirm={async (code) => {
          if (!target) return null;
          const result = await removePasskeyAction({ id: target.id, code });
          if (isActionFail(result)) return result.error;
          onChange(result);
          toast(t("removed"), { variant: "success" });
          return null;
        }}
      />
    </Card>
  );
}
