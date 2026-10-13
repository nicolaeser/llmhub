"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Button,
  Card,
  Chip,
  Description,
  Label,
  ListBox,
  Select,
  Separator,
  Spinner,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { explainAccess } from "@/lib/mcp/resolve";
import { MCP_MODES, MCP_SCOPES } from "@/schemas/mcp";
import type { McpAssignmentMode, McpAssignmentView, McpChain, McpServerView, McpTargetOption, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { loadMcpTargetsAction, saveMcpAssignmentsAction } from "../_action";

const EMPTY_OPTIONS: McpTargetOptions = { org: [], team: [], project: [], member: [], key: [] };

function chainFor(scope: AssignmentScope, option: McpTargetOption): McpChain {
  return {
    orgId: scope === "org" ? option.id : option.orgId,
    teamId: scope === "team" ? option.id : option.teamId,
    projectId: scope === "project" ? option.id : option.projectId,
    memberId: scope === "member" ? option.id : option.memberId,
    keyId: scope === "key" ? option.id : "",
  };
}

function ancestorsOf(rule: McpAssignmentView, options: McpTargetOptions): McpAssignmentView[] {
  const option = options[rule.scope].find((item) => item.id === rule.id);
  if (!option) return [];
  const chain = chainFor(rule.scope, option);
  const levels: [AssignmentScope, string][] = [
    ["org", chain.orgId],
    ["team", chain.teamId],
    ["project", chain.projectId],
    ["member", chain.memberId],
  ];
  return levels
    .filter(([scope, id]) => id && !(scope === rule.scope && id === rule.id))
    .map(([scope, id]) => ({ scope, id, label: "", mode: "allow", blockedTools: [] }));
}

export default function AccessDialog({
  state,
  server,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  server: McpServerView | null;
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp.assign");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const showError = useErrorToast();
  const [global, setGlobal] = useState(server?.global ?? false);
  const [rules, setRules] = useState<McpAssignmentView[]>(server?.assignments ?? []);
  const [options, setOptions] = useState<McpTargetOptions | null>(null);
  const [scope, setScope] = useState<AssignmentScope>("org");
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<McpAssignmentMode>("allow");
  const [previewScope, setPreviewScope] = useState<AssignmentScope>("key");
  const [previewId, setPreviewId] = useState("");
  const [pending, start] = useTransition();
  const isOpen = state.isOpen;
  const toolItems = (server?.tools ?? []).map((tool) => ({ id: tool.name, label: tool.name }));

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    loadMcpTargetsAction().then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        showError(result.error);
        setOptions(EMPTY_OPTIONS);
        return;
      }
      setOptions(result.options);
    });
    return () => {
      active = false;
    };
  }, [isOpen, showError]);

  const known = options ?? EMPTY_OPTIONS;
  const taken = new Set(rules.map((rule) => `${rule.scope}:${rule.id}`));
  const candidates = known[scope].filter((item) => !taken.has(`${scope}:${item.id}`));

  function label(rule: Pick<McpAssignmentView, "scope" | "id">): string {
    return (
      rules.find((item) => item.scope === rule.scope && item.id === rule.id)?.label ||
      known[rule.scope].find((item) => item.id === rule.id)?.label ||
      rule.id
    );
  }

  function sources(list: McpAssignmentView[]): string {
    return format.list(
      list.map((item) => t("source", { scope: item.scope, label: label(item) })),
      { type: "conjunction" },
    );
  }

  function inheritance(rule: McpAssignmentView): { granted: string; blocked: string } {
    const ancestors = ancestorsOf(rule, known).flatMap((ancestor) => {
      const match = rules.find((item) => item.scope === ancestor.scope && item.id === ancestor.id);
      return match ? [match] : [];
    });
    const grants = ancestors.filter((item) => item.mode === "allow");
    const blocks = ancestors.filter((item) => item.mode === "block" && item.blockedTools.length === 0);
    const granted = [grants.length ? sources(grants) : "", global ? t("allCallers") : ""].filter(Boolean);
    return {
      granted: granted.length ? format.list(granted, { type: "conjunction" }) : "",
      blocked: blocks.length ? sources(blocks) : "",
    };
  }

  function addRule() {
    const option = known[scope].find((item) => item.id === target);
    if (!option) return;
    setRules((current) => [...current, { scope, id: option.id, label: option.label, mode, blockedTools: [] }]);
    setTarget("");
  }

  function updateRule(index: number, change: Partial<McpAssignmentView>) {
    setRules((current) => current.map((rule, at) => (at === index ? { ...rule, ...change } : rule)));
  }

  function save(close: () => void) {
    if (!server) return;
    start(async () => {
      const result = await saveMcpAssignmentsAction({
        serverId: server.id,
        global,
        assignments: rules.map((rule) => ({
          scope: rule.scope,
          id: rule.id,
          mode: rule.mode,
          blockedTools: rule.blockedTools,
        })),
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("saved"), { variant: "success" });
      close();
    });
  }

  const previewOption = known[previewScope].find((item) => item.id === previewId) ?? null;
  const explanation =
    server && previewOption ? explainAccess({ ...server, global }, rules, chainFor(previewScope, previewOption)) : null;

  const scopeSelect = (value: AssignmentScope, onChange: (next: AssignmentScope) => void, labelText: string) => (
    <Select
      fullWidth
      selectedKey={value}
      onSelectionChange={(key) => {
        const next = MCP_SCOPES.find((item) => item === String(key));
        if (next) onChange(next);
      }}
      isDisabled={pending}
    >
      <Label>{labelText}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={labelText}>
          {MCP_SCOPES.map((item) => (
            <ListBox.Item key={item} id={item} textValue={t("scope", { scope: item })}>
              {t("scope", { scope: item })}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("title", { name: server?.name ?? "" })}
      description={t("description")}
      submitLabel={t("save")}
      pending={pending}
      isSubmitDisabled={!server || options === null}
      onSubmit={save}
    >
      <Switch isSelected={global} onChange={setGlobal} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("global")}</Label>
        </Switch.Content>
        <Description>{t("globalHint")}</Description>
      </Switch>
      <Separator />
      {options === null ? (
        <output aria-live="polite" aria-label={tCommon("loading")} className="flex justify-center py-6 text-accent">
          <Spinner color="current" />
        </output>
      ) : (
        <>
          <div className="grid items-end gap-3 sm:grid-cols-[10rem_1fr_auto_auto]">
            {scopeSelect(scope, (next) => {
              setScope(next);
              setTarget("");
            }, t("scopeLabel"))}
            <SearchSelect
              label={t("target")}
              items={candidates}
              value={target}
              onChange={setTarget}
              isDisabled={pending}
            />
            <ToggleButtonGroup
              selectionMode="single"
              disallowEmptySelection
              aria-label={t("modeLabel")}
              selectedKeys={[mode]}
              onSelectionChange={(keys) => {
                const next = MCP_MODES.find((item) => item === [...keys][0]);
                if (next) setMode(next);
              }}
              isDisabled={pending}
            >
              {MCP_MODES.map((item, index) => (
                <ToggleButton key={item} id={item}>
                  {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                  {t("mode", { mode: item })}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Button variant="secondary" isDisabled={!target || pending} onPress={addRule}>
              <Plus size={14} aria-hidden />
              {t("add")}
            </Button>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t("rules")}</p>
            {rules.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : null}
            {rules.map((rule, index) => {
              const inherited = inheritance(rule);
              return (
                <Card key={`${rule.scope}:${rule.id}`} variant="secondary">
                  <Card.Content className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{label(rule)}</span>
                          <Chip size="sm" variant="soft">
                            {t("scope", { scope: rule.scope })}
                          </Chip>
                          <Chip size="sm" variant="soft" color={rule.mode === "allow" ? "success" : "danger"}>
                            {rule.mode === "block" && rule.blockedTools.length === 0
                              ? t("blockServer")
                              : t("mode", { mode: rule.mode })}
                          </Chip>
                        </div>
                        {inherited.granted ? (
                          <p className="text-xs text-muted">{t("inherited", { sources: inherited.granted })}</p>
                        ) : null}
                        {inherited.blocked ? (
                          <p className="text-xs text-danger">{t("blockedAbove", { sources: inherited.blocked })}</p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <ToggleButtonGroup
                          size="sm"
                          selectionMode="single"
                          disallowEmptySelection
                          aria-label={t("modeLabel")}
                          selectedKeys={[rule.mode]}
                          onSelectionChange={(keys) => {
                            const next = MCP_MODES.find((item) => item === [...keys][0]);
                            if (next) updateRule(index, { mode: next });
                          }}
                          isDisabled={pending}
                        >
                          {MCP_MODES.map((item, at) => (
                            <ToggleButton key={item} id={item}>
                              {at > 0 ? <ToggleButtonGroup.Separator /> : null}
                              {t("mode", { mode: item })}
                            </ToggleButton>
                          ))}
                        </ToggleButtonGroup>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="danger-soft"
                          aria-label={t("remove", { label: label(rule) })}
                          isDisabled={pending}
                          onPress={() => setRules((current) => current.filter((_, at) => at !== index))}
                        >
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      </div>
                    </div>
                    {toolItems.length ? (
                      <MultiPicker
                        label={t("blockedTools")}
                        description={t("blockedToolsHint", { mode: rule.mode })}
                        placeholder={t("blockedToolsPlaceholder")}
                        searchLabel={tCommon("search")}
                        emptyLabel={tCommon("noResults")}
                        items={toolItems}
                        selected={rule.blockedTools}
                        onChange={(ids) => updateRule(index, { blockedTools: ids })}
                        isDisabled={pending}
                      />
                    ) : null}
                  </Card.Content>
                </Card>
              );
            })}
          </div>
          <Separator />
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{t("preview")}</p>
              <p className="text-sm text-muted">{t("previewHint")}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              {scopeSelect(previewScope, (next) => {
                setPreviewScope(next);
                setPreviewId("");
              }, t("scopeLabel"))}
              <SearchSelect
                label={t("target")}
                items={known[previewScope]}
                value={previewId}
                onChange={setPreviewId}
                isDisabled={pending}
              />
            </div>
            {explanation ? (
              <Card variant="secondary">
                <Card.Content className="space-y-2">
                  <Chip
                    size="sm"
                    variant="soft"
                    color={explanation.state === "granted" ? "success" : explanation.state === "blocked" ? "danger" : "default"}
                  >
                    {t("previewState", { state: explanation.state })}
                  </Chip>
                  {explanation.grantedBy.length || explanation.global ? (
                    <p className="text-sm text-muted">
                      {t("grantedBy", {
                        sources: format.list(
                          [
                            ...(explanation.global ? [t("allCallers")] : []),
                            ...explanation.grantedBy.map((item) => t("source", { scope: item.scope, label: label(item) })),
                          ],
                          { type: "conjunction" },
                        ),
                      })}
                    </p>
                  ) : null}
                  {explanation.blockedBy.length ? (
                    <p className="text-sm text-danger">{t("blockedAbove", { sources: sources(explanation.blockedBy) })}</p>
                  ) : null}
                  {explanation.state === "granted" ? (
                    <p className="text-sm text-muted">
                      {t("previewTools", {
                        count: explanation.tools.length,
                        list: format.list(explanation.tools, { type: "conjunction" }),
                      })}
                    </p>
                  ) : null}
                </Card.Content>
              </Card>
            ) : null}
          </div>
        </>
      )}
    </FormDialog>
  );
}
