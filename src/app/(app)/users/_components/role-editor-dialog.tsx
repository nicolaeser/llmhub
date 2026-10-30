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
import FormDialog from "@/components/console/form-dialog";

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
    <FormDialog
      state={state}
      size="xl"
      title={editing ? t("editTitle", { role: roleName(editing) }) : t("createTitle")}
      description={t("editorHint", { count: selected.length })}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!editing?.templateKey && name.trim().length < 2}
      onSubmit={save}
    >
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
      <p className="text-sm text-muted">{t("levelsHint")}</p>
      <div className="space-y-3">
        {permissionsByDomain(grantable).map((group) => {
          const chosen = group.permissions.filter((permission) => selected.includes(permission)).length;
          const all = chosen === group.permissions.length;
          return (
            <Card key={group.domain} variant="secondary">
              <Card.Header className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Card.Title>{t("domain", { domain: group.domain })}</Card.Title>
                  <Chip size="sm" variant="soft">
                    {t("domainCount", { count: chosen, total: group.permissions.length })}
                  </Chip>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={pending}
                  onPress={() =>
                    setSelected((current) =>
                      all
                        ? current.filter((permission) => !group.permissions.includes(permission))
                        : [...new Set([...current, ...group.permissions])],
                    )
                  }
                >
                  {t("selectDomain", { all: all ? "yes" : "no" })}
                </Button>
              </Card.Header>
              <Card.Content>
                <Fieldset className="gap-0">
                  <Fieldset.Legend className="sr-only">{t("domain", { domain: group.domain })}</Fieldset.Legend>
                  <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
                    {group.permissions.map((permission) => {
                      const key = PERMISSION_KEYS[permission];
                      const level = permissionCatalog[permission].level;
                      return (
                        <div key={permission} className="flex min-w-0 items-start justify-between gap-3">
                          <Checkbox
                            isSelected={selected.includes(permission)}
                            isDisabled={pending}
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
                              <span className="min-w-0">
                                <span className="block text-sm">{t(`permissions.${key}.label`)}</span>
                                <span className="block text-xs text-muted">{t(`permissions.${key}.description`)}</span>
                              </span>
                            </Checkbox.Content>
                          </Checkbox>
                          {level === "view" ? null : (
                            <Chip size="sm" variant="soft" color={level === "sensitive" ? "warning" : "default"}>
                              {t("level", { level })}
                            </Chip>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Fieldset>
              </Card.Content>
            </Card>
          );
        })}
      </div>
    </FormDialog>
  );
}
