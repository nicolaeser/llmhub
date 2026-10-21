"use client";

import { useState, useTransition } from "react";
import {
  Description,
  Input,
  Label,
  Switch,
  TextField,
  toast,
  useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { isActionFail } from "@/lib/http/action-result";
import { useRoleName } from "@/components/security/use-role-name";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { useSecurityError } from "@/components/security/use-security-error";
import type { RoleOption } from "@/types/auth";
import type { ConsoleUser, UsersConsolePayload } from "@/types/users";
import {
  assignUserAccessAction,
  createUserAction,
  setUserPasswordAction,
} from "../_action";
import FormDialog from "@/components/console/form-dialog";

type OverlayState = ReturnType<typeof useOverlayState>;

function defaultRoleId(roles: RoleOption[]) {
  const assignable = roles.filter((role) => role.assignable);
  return (assignable.find((role) => role.templateKey === "viewer") ?? assignable[0])?.id ?? "";
}

function RoleSelect({
  roles,
  value,
  onChange,
  isDisabled,
}: {
  roles: RoleOption[];
  value: string;
  onChange: (id: string) => void;
  isDisabled: boolean;
}) {
  const t = useTranslations("Users");
  const roleName = useRoleName();
  const offered = roles.filter((role) => role.assignable || role.id === value);
  return (
    <SearchSelect
      label={t("fields.role")}
      items={offered.map((role) => ({ id: role.id, label: roleName(role) }))}
      value={value}
      onChange={onChange}
      disabledKeys={offered.filter((role) => !role.assignable).map((role) => role.id)}
      isDisabled={isDisabled}
    />
  );
}

function AccessSelect({
  orgs,
  value,
  onChange,
  isDisabled,
}: {
  orgs: UsersConsolePayload["orgs"];
  value: string;
  onChange: (id: string) => void;
  isDisabled: boolean;
}) {
  const t = useTranslations("Users");
  return (
    <SearchSelect
      label={t("fields.access")}
      items={[
        { id: "platform", label: t("access", { scope: "platform", org: "" }) },
        ...orgs.map((org) => ({ id: org.id, label: t("access", { scope: "company", org: org.alias }) })),
      ]}
      value={value || "platform"}
      onChange={(next) => onChange(next === "platform" ? "" : next)}
      isDisabled={isDisabled}
      description={t("fields.accessHint", { scope: value ? "company" : "platform" })}
    />
  );
}

export function CreateUserDialog({
  state,
  roles,
  orgs,
  onSaved,
}: {
  state: OverlayState;
  roles: RoleOption[];
  orgs: UsersConsolePayload["orgs"];
  onSaved: (payload: UsersConsolePayload) => void;
}) {
  const t = useTranslations("Users");
  const errorText = useSecurityError();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState(() => defaultRoleId(roles));
  const [orgId, setOrgId] = useState("");
  const [pending, start] = useTransition();

  function save(close: () => void) {
    start(async () => {
      const result = await createUserAction({ username, email, password, roleId, orgId });
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onSaved(result);
      toast(t("toasts.created"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="sm"
      title={t("createTitle")}
      submitLabel={t("create")}
      pending={pending}
      isSubmitDisabled={!username.trim() || !email.trim() || !password || !roleId}
      onSubmit={save}
    >
      <TextField fullWidth value={username} onChange={setUsername} isDisabled={pending}>
        <Label>{t("fields.username")}</Label>
        <Input autoComplete="off" />
      </TextField>
      <TextField fullWidth value={email} onChange={setEmail} type="email" isDisabled={pending}>
        <Label>{t("fields.email")}</Label>
        <Input autoComplete="off" />
      </TextField>
      <TextField fullWidth value={password} onChange={setPassword} type="password" isDisabled={pending}>
        <Label>{t("fields.initialPassword")}</Label>
        <Input autoComplete="new-password" />
        <Description>{t("initialPasswordHint")}</Description>
      </TextField>
      <RoleSelect roles={roles} value={roleId} onChange={setRoleId} isDisabled={pending} />
      <AccessSelect orgs={orgs} value={orgId} onChange={setOrgId} isDisabled={pending} />
    </FormDialog>
  );
}

export function ChangeAccessDialog({
  state,
  target,
  roles,
  orgs,
  onSaved,
}: {
  state: OverlayState;
  target: ConsoleUser | null;
  roles: RoleOption[];
  orgs: UsersConsolePayload["orgs"];
  onSaved: (payload: UsersConsolePayload) => void;
}) {
  const t = useTranslations("Users");
  const tCommon = useTranslations("Common");
  const errorText = useSecurityError();
  const [roleId, setRoleId] = useState(target?.roleId ?? "");
  const [orgId, setOrgId] = useState(target?.orgId ?? "");
  const [pending, start] = useTransition();
  const changed = roleId !== target?.roleId || orgId !== (target?.orgId ?? "");

  function save(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await assignUserAccessAction({
        userId: target.id,
        roleId,
        orgId,
        revision: target.revision,
      });
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onSaved(result);
      toast(t("toasts.roleChanged"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="sm"
      title={t("changeRoleTitle", { username: target?.username ?? "" })}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!roleId || !changed}
      onSubmit={save}
    >
      <RoleSelect roles={roles} value={roleId} onChange={setRoleId} isDisabled={pending} />
      <AccessSelect orgs={orgs} value={orgId} onChange={setOrgId} isDisabled={pending} />
      <p className="text-xs text-muted">{t("changeRoleHint")}</p>
    </FormDialog>
  );
}

export function SetPasswordDialog({
  state,
  target,
  onSaved,
}: {
  state: OverlayState;
  target: ConsoleUser | null;
  onSaved: (payload: UsersConsolePayload) => void;
}) {
  const t = useTranslations("Users");
  const [password, setPassword] = useState("");
  const [requireChange, setRequireChange] = useState(true);
  const stepUp = useOverlayState();

  return (
    <>
      <FormDialog
        state={state}
        size="sm"
        title={t("setPasswordTitle")}
        description={t("setPasswordHint")}
        submitLabel={t("setPassword")}
        isSubmitDisabled={!password}
        onSubmit={() => stepUp.open()}
      >
        <TextField fullWidth value={password} onChange={setPassword} type="password" isDisabled={stepUp.isOpen}>
          <Label>{t("fields.password")}</Label>
          <Input autoComplete="new-password" />
        </TextField>
        <Switch isSelected={requireChange} onChange={setRequireChange} isDisabled={stepUp.isOpen}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("requireChange")}</Label>
          </Switch.Content>
        </Switch>
      </FormDialog>
      <StepUpDialog
        state={stepUp}
        title={t("setPasswordTitle")}
        description={t("setPasswordStepUp", { username: target?.username ?? "" })}
        confirmLabel={t("setPassword")}
        onConfirm={async (code) => {
          if (!target) return null;
          const result = await setUserPasswordAction({
            userId: target.id,
            password,
            requireChange,
            code,
          });
          if (isActionFail(result)) return result.error;
          onSaved(result);
          setPassword("");
          toast(t("toasts.passwordSet"), { variant: "success" });
          state.close();
          return null;
        }}
      />
    </>
  );
}
