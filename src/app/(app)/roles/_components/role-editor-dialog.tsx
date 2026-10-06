"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  Fieldset,
  Input,
  Label,
  Modal,
  Spinner,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { permissionCatalog, permissionsByDomain } from "@/lib/auth/permissions";
import { useRoleName } from "@/components/security/use-role-name";
import { PERMISSION_KEYS } from "@/components/security/permission-keys";
import { useSecurityError } from "@/components/security/use-security-error";
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
  const tCommon = useTranslations("Common");
  const roleName = useRoleName();
  const errorText = useSecurityError();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [selected, setSelected] = useState<Permission[]>(editing?.permissions ?? []);
  const [pending, start] = useTransition();
  const allowed = new Set(grantable);

  function save(close: () => void) {
    start(async () => {
      const input = {
        name: name.trim() || null,
        description: description.trim() || null,
        permissions: selected,
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
