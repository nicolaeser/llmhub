"use client";

import { useState, useTransition } from "react";
import {
  Card,
  Description,
  Input,
  Label,
  Radio,
  RadioGroup,
  Switch,
  TextField,
  toast,
  useOverlayState,
} from "@heroui/react";
import { Building2, Globe, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
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

type AccessMode = "platform" | "company";

const ACCESS_MODES: { id: AccessMode; icon: LucideIcon }[] = [
  { id: "platform", icon: Globe },
  { id: "company", icon: Building2 },
];

function RoleSelect({
  roles,
  value,
  onChange,
  isDisabled,
  description,
}: {
  roles: RoleOption[];
  value: string;
  onChange: (id: string) => void;
  isDisabled: boolean;
  description?: string;
}) {
  const t = useTranslations("Users");
  const tRoles = useTranslations("Roles");
  const roleName = useRoleName();
  const offered = roles.filter((role) => role.assignable || role.id === value);
  const selected = offered.find((role) => role.id === value);
  const explained = selected
    ? selected.templateKey && !selected.name
      ? tRoles("templateDescription", { key: selected.templateKey })
      : selected.templateKey
        ? tRoles("templateBased", { template: tRoles("templateName", { key: selected.templateKey }) })
        : t("customRole")
    : t("pickRole");
  return (
    <SearchSelect
      label={t("fields.role")}
      items={offered.map((role) => ({
        id: role.id,
        label: roleName(role),
        detail: role.templateKey && !role.name ? tRoles("templateDescription", { key: role.templateKey }) : undefined,
      }))}
      value={value}
      onChange={onChange}
      disabledKeys={offered.filter((role) => !role.assignable).map((role) => role.id)}
      isDisabled={isDisabled}
      description={description ?? explained}
    />
  );
}

function AccessFields({
  orgs,
  mode,
  value,
  onModeChange,
  onChange,
  isDisabled,
}: {
  orgs: UsersConsolePayload["orgs"];
  mode: AccessMode;
  value: string;
  onModeChange: (mode: AccessMode) => void;
  onChange: (id: string) => void;
  isDisabled: boolean;
}) {
  const t = useTranslations("Users");
  return (
    <div className="space-y-3">
      <RadioGroup
        value={mode}
        onChange={(next) => onModeChange(next === "company" ? "company" : "platform")}
        isDisabled={isDisabled || orgs.length === 0}
        className="gap-2"
      >
        <Label>{t("fields.access")}</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {ACCESS_MODES.map((item) => {
            const selected = item.id === mode;
            return (
              <Card
                key={item.id}
                variant="secondary"
                className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
              >
                <Radio value={item.id} className="mt-0 h-full w-full">
                  <Radio.Content className="h-full w-full items-start gap-3 p-3">
                    <IconTile icon={item.icon} tone={selected ? "accent" : "neutral"} size="sm" />
                    <span className="min-w-0 flex-1 space-y-1">
                      <Label>{t("accessMode.title", { mode: item.id })}</Label>
                      <span className="block text-xs font-normal text-muted">{t("fields.accessHint", { scope: item.id })}</span>
                    </span>
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                  </Radio.Content>
                </Radio>
              </Card>
            );
          })}
        </div>
      </RadioGroup>
      {mode === "company" ? (
        <SearchSelect
          isRequired
          label={t("fields.company")}
          placeholder={t("fields.companyPlaceholder")}
          items={orgs.map((org) => ({ id: org.id, label: org.alias }))}
          value={value}
          onChange={onChange}
          isDisabled={isDisabled}
        />
      ) : null}
    </div>
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
  const [mode, setMode] = useState<AccessMode>("platform");
  const [pending, start] = useTransition();

  function save(close: () => void) {
    start(async () => {
      const result = await createUserAction({ username, email, password, roleId, orgId: mode === "company" ? orgId : "" });
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
      size="md"
      title={t("createTitle")}
      description={t("createHint")}
      submitLabel={t("create")}
      pending={pending}
      isSubmitDisabled={!username.trim() || !email.trim() || !password || !roleId || (mode === "company" && !orgId)}
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
      <AccessFields
        orgs={orgs}
        mode={mode}
        value={orgId}
        onModeChange={setMode}
        onChange={setOrgId}
        isDisabled={pending}
      />
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
  const [mode, setMode] = useState<AccessMode>(target?.orgId ? "company" : "platform");
  const [pending, start] = useTransition();
  const nextOrg = mode === "company" ? orgId : "";
  const changed = roleId !== target?.roleId || nextOrg !== (target?.orgId ?? "");

  function save(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await assignUserAccessAction({
        userId: target.id,
        roleId,
        orgId: nextOrg,
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
      size="md"
      title={t("changeRoleTitle", { username: target?.username ?? "" })}
      description={target?.managedBy ? undefined : t("changeRoleHint")}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!roleId || !changed || (mode === "company" && !orgId)}
      onSubmit={save}
    >
      <RoleSelect
        roles={roles}
        value={roleId}
        onChange={setRoleId}
        isDisabled={pending || Boolean(target?.managedBy)}
        description={target?.managedBy ? t("managed.hint", { provider: target.managedBy }) : undefined}
      />
      <AccessFields
        orgs={orgs}
        mode={mode}
        value={orgId}
        onModeChange={setMode}
        onChange={setOrgId}
        isDisabled={pending}
      />
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
