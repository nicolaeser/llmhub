"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  Disclosure,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Switch,
  TextField,
  toast,
  useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useRoleName } from "@/components/security/use-role-name";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { useSecurityError } from "@/components/security/use-security-error";
import type { RoleOption } from "@/types/auth";
import type { ConsoleUser, UsersConsolePayload } from "@/types/users";
import {
  assignUserRoleAction,
  createUserAction,
  deleteUserAction,
  setUserPasswordAction,
} from "../_action";

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
  return (
    <Select
      selectedKey={value || null}
      onSelectionChange={(key) => onChange(String(key))}
      disabledKeys={roles.filter((role) => !role.assignable).map((role) => role.id)}
      isDisabled={isDisabled}
      fullWidth
    >
      <Label>{t("fields.role")}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={t("fields.role")}>
          {roles.map((role) => (
            <ListBox.Item key={role.id} id={role.id} textValue={roleName(role)}>
              {roleName(role)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function CreateUserDialog({
  state,
  roles,
  orgs,
  teams,
  onSaved,
}: {
  state: OverlayState;
  roles: RoleOption[];
  orgs: UsersConsolePayload["orgs"];
  teams: UsersConsolePayload["teams"];
  onSaved: (payload: UsersConsolePayload) => void;
}) {
  const t = useTranslations("Users");
  const tCommon = useTranslations("Common");
  const errorText = useSecurityError();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState(() => defaultRoleId(roles));
  const [orgId, setOrgId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [pending, start] = useTransition();

  function save(close: () => void) {
    start(async () => {
      const result = await createUserAction({ username, email, password, roleId, orgId, teamId });
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
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("createTitle")}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
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
                  <Disclosure>
                    <Disclosure.Heading>
                      <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
                        {tCommon("advanced")}
                        <Disclosure.Indicator />
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <Disclosure.Body className="space-y-4 pt-3">
                        <Select
                          selectedKey={orgId || "none"}
                          onSelectionChange={(key) => {
                            const next = String(key) === "none" ? "" : String(key);
                            setOrgId(next);
                            if (next && teams.find((team) => team.id === teamId)?.orgId !== next) {
                              setTeamId("");
                            }
                          }}
                          isDisabled={pending}
                          fullWidth
                        >
                          <Label>{t("fields.org")}</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox aria-label={t("fields.org")}>
                              <ListBox.Item id="none" textValue={t("fields.none")}>
                                {t("fields.none")}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                              {orgs.map((org) => (
                                <ListBox.Item key={org.id} id={org.id} textValue={org.alias}>
                                  {org.alias}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                          <Description>{t("fields.orgHint")}</Description>
                        </Select>
                        <Select
                          selectedKey={teamId || "none"}
                          onSelectionChange={(key) => {
                            const next = teams.find((team) => team.id === String(key));
                            setTeamId(next?.id ?? "");
                            if (next?.orgId) setOrgId(next.orgId);
                          }}
                          isDisabled={pending}
                          fullWidth
                        >
                          <Label>{t("fields.team")}</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox aria-label={t("fields.team")}>
                              <ListBox.Item id="none" textValue={t("fields.none")}>
                                {t("fields.none")}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                              {teams
                                .filter((team) => !orgId || team.orgId === orgId)
                                .map((team) => (
                                  <ListBox.Item key={team.id} id={team.id} textValue={team.alias}>
                                    {team.alias}
                                    <ListBox.ItemIndicator />
                                  </ListBox.Item>
                                ))}
                            </ListBox>
                          </Select.Popover>
                          <Description>{t("fields.teamHint")}</Description>
                        </Select>
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!username.trim() || !email.trim() || !password || !roleId}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("create")}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function ChangeRoleDialog({
  state,
  target,
  roles,
  onSaved,
}: {
  state: OverlayState;
  target: ConsoleUser | null;
  roles: RoleOption[];
  onSaved: (payload: UsersConsolePayload) => void;
}) {
  const t = useTranslations("Users");
  const tCommon = useTranslations("Common");
  const errorText = useSecurityError();
  const [roleId, setRoleId] = useState(target?.roleId ?? "");
  const [pending, start] = useTransition();

  function save(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await assignUserRoleAction({
        userId: target.id,
        roleId,
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
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("changeRoleTitle", { username: target?.username ?? "" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <RoleSelect roles={roles} value={roleId} onChange={setRoleId} isDisabled={pending} />
                  <p className="text-xs text-muted">{t("changeRoleHint")}</p>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!roleId || roleId === target?.roleId}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {tCommon("save")}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
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
  const tCommon = useTranslations("Common");
  const [password, setPassword] = useState("");
  const [requireChange, setRequireChange] = useState(true);
  const stepUp = useOverlayState();

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("setPasswordTitle")}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <p className="text-sm text-muted">{t("setPasswordHint")}</p>
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
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close}>
                    {tCommon("cancel")}
                  </Button>
                  <Button isDisabled={!password} onPress={stepUp.open}>
                    {t("setPassword")}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
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
    </Modal>
  );
}

export function DeleteUserDialog({
  state,
  target,
  onDeleted,
}: {
  state: OverlayState;
  target: ConsoleUser | null;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Users");
  const tCommon = useTranslations("Common");
  const errorText = useSecurityError();
  const [pending, start] = useTransition();

  function remove(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await deleteUserAction(target.id);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onDeleted(result.id);
      toast(t("toasts.deleted"), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("deleteTitle")}</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <p className="text-sm text-muted">
                    {t("deleteConfirm", { username: target?.username ?? "" })}
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button variant="danger" isPending={pending} onPress={() => remove(close)}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {tCommon("delete")}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
