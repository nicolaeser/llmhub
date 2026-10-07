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
  Modal,
  Spinner,
  Tabs,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { permissionCatalog, permissionsByDomain } from "@/lib/auth/permissions";
import {
  assistantToolCatalog,
  assistantToolNames,
  assistantToolsByGroup,
  isWriteAccess,
} from "@/lib/assistant/catalog";
import { useRoleName } from "@/components/security/use-role-name";
import { PERMISSION_KEYS } from "@/components/security/permission-keys";
import { useSecurityError } from "@/components/security/use-security-error";
import type { AssistantToolName } from "@/types/assistant";
import type { Permission, RoleSummary } from "@/types/auth";
import { createRoleAction, updateRoleAction } from "../_action";

export default function RoleEditorDialog({
  state,
  editing,
  grantable,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: RoleSummary | null;
  grantable: Permission[];
  onSaved: (role: RoleSummary) => void;
}) {
  const t = useTranslations("Roles");
  const tAssistant = useTranslations("Assistant");
  const tCommon = useTranslations("Common");
  const roleName = useRoleName();
  const errorText = useSecurityError();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [selected, setSelected] = useState<Permission[]>(editing?.permissions ?? []);
  const [toolsOff, setToolsOff] = useState<AssistantToolName[]>(editing?.assistantToolsDisabled ?? []);
  const [pending, start] = useTransition();
  const allowed = new Set(grantable);

  function save(close: () => void) {
    start(async () => {
      const input = {
        name: name.trim() || null,
        description: description.trim() || null,
        permissions: selected,
        assistantToolsDisabled: toolsOff,
      };
      const result = editing
        ? await updateRoleAction(editing.id, { ...input, revision: editing.revision })
        : await createRoleAction(input);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      onSaved(result.role);
      toast(t(editing ? "toasts.updated" : "toasts.created"), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>
                    {editing ? t("editTitle", { role: roleName(editing) }) : t("createTitle")}
                  </Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField fullWidth value={name} onChange={setName} isDisabled={pending} maxLength={80}>
                      <Label>{t("fields.name")}</Label>
                      <Input
                        placeholder={editing?.templateKey ? t("templateName", { key: editing.templateKey }) : undefined}
                      />
                    </TextField>
                    <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending} maxLength={500}>
                      <Label>{t("fields.description")}</Label>
                      <Input />
                    </TextField>
                  </div>
                  <Tabs aria-label={t("tabs.label")}>
                    <Tabs.List aria-label={t("tabs.label")} className="w-fit">
                      <Tabs.Tab id="permissions" className="w-auto">
                        {t("tabs.permissions", { count: selected.length })}
                      </Tabs.Tab>
                      <Tabs.Tab id="tools" className="w-auto">
                        {t("tabs.tools", { off: toolsOff.length })}
                      </Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel id="permissions" className="space-y-5 pt-4">
                      {permissionsByDomain().map((group) => (
                        <Fieldset key={group.domain} className="gap-2">
                          <Fieldset.Legend>{t("domain", { domain: group.domain })}</Fieldset.Legend>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {group.permissions.map((permission) => {
                              const key = PERMISSION_KEYS[permission];
                              const level = permissionCatalog[permission].level;
                              return (
                                <Card
                                  key={permission}
                                  variant="secondary"
                                  className="flex-row items-start justify-between gap-3 px-3 py-2"
                                >
                                  <Checkbox
                                    isSelected={selected.includes(permission)}
                                    isDisabled={pending || !allowed.has(permission)}
                                    onChange={(checked) =>
                                      setSelected((current) =>
                                        checked
                                          ? [...current, permission]
                                          : current.filter((item) => item !== permission),
                                      )
                                    }
                                  >
                                    <Checkbox.Content>
                                      <Checkbox.Control>
                                        <Checkbox.Indicator />
                                      </Checkbox.Control>
                                      <span className="min-w-0">
                                        <span className="block text-sm">{t(`permissions.${key}.label`)}</span>
                                        <span className="block text-xs text-muted">
                                          {t(`permissions.${key}.description`)}
                                        </span>
                                      </span>
                                    </Checkbox.Content>
                                  </Checkbox>
                                  <Chip
                                    size="sm"
                                    variant="soft"
                                    color={level === "sensitive" ? "warning" : level === "work" ? "accent" : "default"}
                                  >
                                    {t("level", { level })}
                                  </Chip>
                                </Card>
                              );
                            })}
                          </div>
                        </Fieldset>
                      ))}
                    </Tabs.Panel>
                    <Tabs.Panel id="tools" className="space-y-5 pt-4">
                      {selected.includes("assistant:use") ? null : (
                        <Alert status="warning">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Description>{t("tools.noAssistant")}</Alert.Description>
                          </Alert.Content>
                        </Alert>
                      )}
                      <p className="text-sm text-muted">{t("tools.hint")}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => setToolsOff([])}>
                          {t("tools.enableAll")}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={pending}
                          onPress={() =>
                            setToolsOff(
                              assistantToolNames.filter((name) => isWriteAccess(assistantToolCatalog[name].access)),
                            )
                          }
                        >
                          {t("tools.readOnly")}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={pending}
                          onPress={() => setToolsOff([...assistantToolNames])}
                        >
                          {t("tools.disableAll")}
                        </Button>
                      </div>
                      {assistantToolsByGroup().map(({ group, tools }) => (
                        <Fieldset key={group} className="gap-2">
                          <Fieldset.Legend>{tAssistant("tools.group", { group })}</Fieldset.Legend>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {tools.map((name) => {
                              const { access, permission } = assistantToolCatalog[name];
                              const missing = permission && !selected.includes(permission) ? permission : null;
                              return (
                                <Card
                                  key={name}
                                  variant="secondary"
                                  className="flex-row items-start justify-between gap-3 px-3 py-2"
                                >
                                  <Checkbox
                                    isSelected={!toolsOff.includes(name)}
                                    isDisabled={pending}
                                    onChange={(checked) =>
                                      setToolsOff((current) =>
                                        checked ? current.filter((item) => item !== name) : [...current, name],
                                      )
                                    }
                                  >
                                    <Checkbox.Content>
                                      <Checkbox.Control>
                                        <Checkbox.Indicator />
                                      </Checkbox.Control>
                                      <span className="min-w-0">
                                        <span className="block text-sm">{tAssistant("toolName", { name })}</span>
                                        <span className="block text-xs text-muted">
                                          {tAssistant("toolHint", { name })}
                                        </span>
                                        {missing ? (
                                          <span className="block text-xs text-warning">
                                            {t("tools.needs", {
                                              permission: t(`permissions.${PERMISSION_KEYS[missing]}.label`),
                                            })}
                                          </span>
                                        ) : null}
                                      </span>
                                    </Checkbox.Content>
                                  </Checkbox>
                                  <Chip
                                    size="sm"
                                    variant="soft"
                                    color={access === "destructive" ? "warning" : access === "write" ? "accent" : "default"}
                                  >
                                    {t("tools.access", { access })}
                                  </Chip>
                                </Card>
                              );
                            })}
                          </div>
                        </Fieldset>
                      ))}
                    </Tabs.Panel>
                  </Tabs>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!editing?.templateKey && name.trim().length < 2}
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
