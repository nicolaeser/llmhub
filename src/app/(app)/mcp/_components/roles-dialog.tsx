"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import MultiPicker from "@/components/console/multi-picker";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { MCP_ACTIONS } from "@/schemas/mcp";
import type { McpRoleView, McpServerView } from "@/types/mcp";
import { deleteMcpRoleAction, ensureMcpRolesAction, saveMcpRoleAction } from "../_action";

const EMPTY = {
  id: "",
  name: "",
  description: "",
  allTools: true,
  tools: [] as string[],
  allActions: false,
  actions: ["read"] as string[],
  builtin: false,
};

export default function RolesDialog({
  state,
  server,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  server: McpServerView | null;
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [draft, setDraft] = useState(EMPTY);
  const [pending, start] = useTransition();
  const tools = (server?.tools ?? []).map((tool) => ({ id: tool.name, label: tool.name }));
  const builtinCount = (server?.roles ?? []).filter((role) => role.builtin).length;
  const ensured = useRef("");

  useEffect(() => {
    if (!state.isOpen || !server || builtinCount >= 3 || ensured.current === server.id) return;
    ensured.current = server.id;
    const report = onSaved;
    start(async () => {
      const result = await ensureMcpRolesAction(server.id);
      if (isActionFail(result)) {
        ensured.current = "";
        showError(result.error);
        return;
      }
      report(result.server);
    });
  }, [builtinCount, onSaved, server, showError, start, state.isOpen]);

  function choose(role: McpRoleView) {
    setDraft({
      id: role.id,
      name: role.name,
      description: role.description,
      allTools: role.allTools,
      tools: role.tools,
      allActions: role.allActions,
      actions: role.actions,
      builtin: role.builtin,
    });
  }

  function save(close: () => void) {
    if (!server) return;
    start(async () => {
      const result = await saveMcpRoleAction({
        serverId: server.id,
        id: draft.id,
        name: draft.name,
        description: draft.description,
        allTools: draft.allTools,
        tools: draft.tools,
        allActions: draft.allActions,
        actions: draft.actions,
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("roles.saved"), { variant: "success" });
      close();
    });
  }

  function remove() {
    if (!draft.id || draft.builtin) return;
    start(async () => {
      const result = await deleteMcpRoleAction(draft.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      setDraft(EMPTY);
      toast(t("roles.deleted"), { variant: "success" });
    });
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("roles.title", { name: server?.name ?? "" })}
      description={t("roles.description")}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!server || !draft.name.trim()}
      onSubmit={save}
    >
      <div className="flex flex-wrap gap-2">
        {(server?.roles ?? []).map((role) => (
          <Button key={role.id} size="sm" variant={draft.id === role.id ? "primary" : "tertiary"} onPress={() => choose(role)}>
            {role.builtin ? t("assign.rolePreset", { role: role.key }) : role.name}
          </Button>
        ))}
        <Button size="sm" variant="secondary" onPress={() => setDraft(EMPTY)}>
          <Plus size={14} aria-hidden />
          {t("roles.create")}
        </Button>
      </div>
      <TextField value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} isDisabled={draft.builtin || pending}>
        <Label>{t("roles.name")}</Label>
        <Input />
        <Description>{draft.builtin ? t("roles.builtinHint") : t("roles.nameHint")}</Description>
      </TextField>
      <TextField value={draft.description} onChange={(description) => setDraft((current) => ({ ...current, description }))} isDisabled={pending}>
        <Label>{t("roles.roleDescription")}</Label>
        <Input />
      </TextField>
      <Switch isSelected={draft.allTools} onChange={(allTools) => setDraft((current) => ({ ...current, allTools }))} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("roles.allTools")}</Label>
        </Switch.Content>
      </Switch>
      {draft.allTools ? null : (
        <MultiPicker
          label={t("roles.tools")}
          description={t("roles.toolsHint")}
          placeholder={t("roles.toolsEmpty")}
          searchLabel={tCommon("search")}
          emptyLabel={tCommon("noResults")}
          items={tools}
          selected={draft.tools}
          onChange={(ids) => setDraft((current) => ({ ...current, tools: ids }))}
          isDisabled={pending}
        />
      )}
      <Switch isSelected={draft.allActions} onChange={(allActions) => setDraft((current) => ({ ...current, allActions }))} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("roles.allActions")}</Label>
        </Switch.Content>
      </Switch>
      {draft.allActions ? null : (
        <div className="space-y-2">
          <Label>{t("roles.actions")}</Label>
          <ToggleButtonGroup
            selectionMode="multiple"
            selectedKeys={draft.actions}
            onSelectionChange={(keys) =>
              setDraft((current) => ({ ...current, actions: MCP_ACTIONS.filter((action) => keys.has(action)) }))
            }
            isDisabled={pending}
          >
            {MCP_ACTIONS.map((action, index) => (
              <ToggleButton key={action} id={action}>
                {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                {t("action", { action })}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Description>{t("roles.actionsHint")}</Description>
        </div>
      )}
      {draft.id && !draft.builtin ? (
        <Button variant="danger-soft" onPress={remove} isDisabled={pending}>
          <Trash2 size={14} aria-hidden />
          {t("roles.delete")}
        </Button>
      ) : null}
    </FormDialog>
  );
}
