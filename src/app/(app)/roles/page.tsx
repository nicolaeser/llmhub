"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  Chip,
  Dropdown,
  Spinner,
  Table,
  toast,
  useOverlayState,
} from "@heroui/react";
import { MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { permissionCatalog, roleTemplateKeys } from "@/lib/auth/permissions";
import { useRoleName } from "@/components/security/use-role-name";
import { useSecurityError } from "@/components/security/use-security-error";
import type { RoleSummary, RoleTemplateKey } from "@/types/auth";
import RoleEditorDialog from "./_components/role-editor-dialog";
import { deleteRoleAction, loadRolesAction, resetRoleAction, restoreTemplateAction } from "./_action";

function templateRank(key: RoleTemplateKey | null) {
  const index = key ? roleTemplateKeys.indexOf(key) : -1;
  return index === -1 ? roleTemplateKeys.length : index;
}

function placeRole(roles: RoleSummary[], role: RoleSummary) {
  if (roles.some((row) => row.id === role.id)) {
    return roles.map((row) => (row.id === role.id ? role : row));
  }
  return [...roles, role].sort((a, b) => templateRank(a.templateKey) - templateRank(b.templateKey));
}

export default function RolesPage() {
  const t = useTranslations("Roles");
  const tCommon = useTranslations("Common");
  const roleName = useRoleName();
  const errorText = useSecurityError();
  const [editing, setEditing] = useState<RoleSummary | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [target, setTarget] = useState<RoleSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [, startDelete] = useTransition();
  const editor = useOverlayState();
  const deleteState = useOverlayState();
  const page = useActionData(loadRolesAction);
  const { data, setData } = page;

  function openEditor(role: RoleSummary | null) {
    setEditing(role);
    setEditorKey((n) => n + 1);
    editor.open();
  }

  function saved(role: RoleSummary) {
    setData((current) => ({ ...current, roles: placeRole(current.roles, role) }));
  }

  function deleted(role: RoleSummary) {
    setData((current) => ({
      ...current,
      roles: current.roles.filter((row) => row.id !== role.id),
      missingTemplates: roleTemplateKeys.filter(
        (key) => key === role.templateKey || current.missingTemplates.includes(key),
      ),
    }));
  }

  function remove(role: RoleSummary) {
    setDeletingId(role.id);
    startDelete(async () => {
      const result = await deleteRoleAction(role.id);
      setDeletingId(null);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      deleted(role);
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  function reset(role: RoleSummary) {
    start(async () => {
      const result = await resetRoleAction(role.id, role.revision);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      saved(result.role);
      toast(t("toasts.reset"), { variant: "success" });
    });
  }

  function restore(key: RoleTemplateKey) {
    start(async () => {
      const result = await restoreTemplateAction(key);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      setData((current) => ({
        ...current,
        roles: placeRole(current.roles, result.role),
        missingTemplates: current.missingTemplates.filter((item) => item !== key),
      }));
      toast(t("toasts.restored"), { variant: "success" });
    });
  }

  if (!data) {
    return <PageStatus title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onPress={() => openEditor(null)}>
            <Plus size={16} aria-hidden />
            {t("create")}
          </Button>
        }
      />
      <Table aria-label={t("title")}>
        <Table.ScrollContainer>
          <Table.Content>
            <Table.Header>
              <Table.Column isRowHeader>{t("columns.role")}</Table.Column>
              <Table.Column>{t("columns.members")}</Table.Column>
              <Table.Column>{t("columns.permissions")}</Table.Column>
              <Table.Column>{tCommon("actions")}</Table.Column>
            </Table.Header>
            <Table.Body>
              {data.roles.map((role) => (
                <Table.Row key={role.id} id={role.id}>
                  <Table.Cell>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {roleName(role)}
                        {role.templateKey ? (
                          <Chip size="sm" variant="soft">
                            {t("builtIn")}
                          </Chip>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted">
                        {role.description ??
                          (role.templateKey ? t("templateDescription", { key: role.templateKey }) : "")}
                      </p>
                    </div>
                  </Table.Cell>
                  <Table.Cell>{t("members", { count: role.memberCount })}</Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap gap-1">
                      <Chip size="sm" variant="soft">
                        {t("permissionCount", { count: role.permissions.length })}
                      </Chip>
                      {role.permissions.some((permission) => permissionCatalog[permission].level === "sensitive") ? (
                        <Chip size="sm" variant="soft" color="warning">
                          {t("level", { level: "sensitive" })}
                        </Chip>
                      ) : null}
                      {role.assistantToolsDisabled.length ? (
                        <Chip size="sm" variant="soft">
                          {t("toolsOff", { count: role.assistantToolsDisabled.length })}
                        </Chip>
                      ) : null}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    {role.editable ? (
                      <Dropdown>
                        <Dropdown.Trigger>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            isPending={deletingId === role.id}
                            aria-label={t("actionsMenu", { role: roleName(role) })}
                          >
                            {({ isPending }) =>
                              isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={14} aria-hidden />
                            }
                          </Button>
                        </Dropdown.Trigger>
                        <Dropdown.Popover>
                          <Dropdown.Menu
                            aria-label={t("actionsMenu", { role: roleName(role) })}
                            onAction={(key) => {
                              if (key === "edit") openEditor(role);
                              if (key === "delete") {
                                setTarget(role);
                                deleteState.open();
                              }
                              if (key === "reset") reset(role);
                            }}
                          >
                            <Dropdown.Item id="edit" textValue={t("edit")}>
                              {t("edit")}
                            </Dropdown.Item>
                            {role.templateKey ? (
                              <Dropdown.Item id="reset" textValue={t("reset")}>
                                {t("reset")}
                              </Dropdown.Item>
                            ) : null}
                            {role.memberCount === 0 ? (
                              <Dropdown.Item id="delete" textValue={tCommon("delete")}>
                                {tCommon("delete")}
                              </Dropdown.Item>
                            ) : null}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    ) : (
                      <Chip size="sm" variant="soft">
                        {t("protected")}
                      </Chip>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>

      {data.missingTemplates.length ? (
        <Card className="mt-6">
          <Card.Header>
            <Card.Title>{t("missingTitle")}</Card.Title>
            <Card.Description>{t("missingHint")}</Card.Description>
          </Card.Header>
          <Card.Footer className="flex-wrap gap-2">
            {data.missingTemplates.map((key) => (
              <Button
                key={key}
                size="sm"
                variant="secondary"
                isDisabled={pending}
                onPress={() => restore(key)}
              >
                <RotateCcw size={14} aria-hidden />
                {t("restore", { name: t("templateName", { key }) })}
              </Button>
            ))}
          </Card.Footer>
        </Card>
      ) : null}

      <RoleEditorDialog
        key={editorKey}
        state={editor}
        editing={editing}
        grantable={data.grantable}
        onSaved={saved}
      />
      <ConfirmDialog
        state={deleteState}
        title={t("deleteTitle")}
        description={t("deleteConfirm", { role: target ? roleName(target) : "" })}
        confirmLabel={tCommon("delete")}
        cancelLabel={tCommon("cancel")}
        onConfirm={() => {
          if (target) remove(target);
        }}
      />
    </div>
  );
}
