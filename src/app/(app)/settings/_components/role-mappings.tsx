"use client";

import { useRef } from "react";
import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { MAX_ROLE_MAPPINGS } from "@/lib/auth/oidc-presets";
import type { RoleMapping } from "@/types/auth";
import OptionSelect from "./option-select";

export type MappingRow = RoleMapping & { key: string };

export default function RoleMappings({
  rows,
  roles,
  appRoles,
  canEdit,
  isDisabled,
  onChange,
}: {
  rows: MappingRow[];
  roles: readonly { id: string; label: string }[];
  appRoles: boolean;
  canEdit: boolean;
  isDisabled: boolean;
  onChange: (rows: MappingRow[]) => void;
}) {
  const t = useTranslations("Settings.signIn.mapping");
  const seq = useRef(0);
  const edit = (key: string, patch: Partial<RoleMapping>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-3">
      {rows.length ? (
        rows.map((row, index) => (
          <Card key={row.key} variant="secondary">
            <Card.Content className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
              <TextField
                fullWidth
                isRequired
                value={row.group}
                onChange={(group) => edit(row.key, { group })}
                isDisabled={isDisabled}
              >
                <Label>{t("group", { position: index + 1 })}</Label>
                <Input placeholder={t("groupPlaceholder")} />
              </TextField>
              <OptionSelect
                label={t("role", { position: index + 1 })}
                value={row.role_id}
                options={roles}
                onChange={(role_id) => edit(row.key, { role_id })}
                isDisabled={isDisabled}
              />
              {canEdit ? (
                <Button
                  isIconOnly
                  variant="danger-soft"
                  aria-label={t("remove", { position: index + 1 })}
                  isDisabled={isDisabled}
                  onPress={() => onChange(rows.filter((item) => item.key !== row.key))}
                >
                  <Trash2 size={16} aria-hidden />
                </Button>
              ) : null}
            </Card.Content>
          </Card>
        ))
      ) : (
        <p className="text-sm text-muted">{t("empty", { appRoles: appRoles ? "true" : "false" })}</p>
      )}
      {canEdit ? (
        <Button
          variant="secondary"
          isDisabled={isDisabled || rows.length >= MAX_ROLE_MAPPINGS || !roles.length}
          onPress={() => {
            seq.current += 1;
            onChange([...rows, { key: `new-${seq.current}`, group: "", role_id: roles[0]?.id ?? "" }]);
          }}
        >
          <Plus size={16} aria-hidden />
          {t("add")}
        </Button>
      ) : null}
    </div>
  );
}
