"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Separator,
  Spinner,
  Switch,
  TextArea,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import MultiPicker from "@/components/console/multi-picker";
import { createKeyAction, updateKeyAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { KeyOptions } from "@/types/keys";
import type { VirtualKeyView } from "@/types/gateway";

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function KeyDialog({
  state,
  editing,
  options,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: VirtualKeyView | null;
  options: KeyOptions;
  onSaved: (key: VirtualKeyView, secret: string | null) => void;
}) {
  const t = useTranslations("Keys");
  const tTemplates = useTranslations("ModelTemplates");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [alias, setAlias] = useState(editing?.key_alias ?? "");
  const [teamId, setTeamId] = useState(editing?.team_id ?? "");
  const [projectId, setProjectId] = useState(editing?.project_id ?? "");
  const [models, setModels] = useState<string[]>(editing?.models ?? []);
  const [templateIds, setTemplateIds] = useState<string[]>(editing?.templates ?? []);
  const [rpm, setRpm] = useState(String(editing?.rpm_limit ?? 0));
  const [tpm, setTpm] = useState(String(editing?.tpm_limit ?? 0));
  const [days, setDays] = useState("");
  const [ips, setIps] = useState((editing?.allowed_ips ?? []).join("\n"));
  const [blocked, setBlocked] = useState(editing?.blocked ?? false);
  const [logContent, setLogContent] = useState(editing?.log_content ?? true);
  const [pending, start] = useTransition();
  const projects = options.projects.filter((p) => !p.teamId || p.teamId === teamId);
  const allowed = new Set([
    ...models,
    ...options.templates
      .filter((template) => templateIds.includes(template.id))
      .flatMap((template) => template.matches),
  ]);
  const access =
    models.length === 0 && templateIds.length === 0 ? "all" : allowed.size === 0 ? "none" : "some";

  function save(close: () => void) {
    start(async () => {
      const shared = {
        alias: alias.trim(),
        teamId,
        projectId,
        models,
        templateIds,
        rpm: Number(rpm) || 0,
        tpm: Number(tpm) || 0,
        allowedIps: splitList(ips),
        logContent,
      };
      if (editing) {
        const result = await updateKeyAction({ ...shared, id: editing.token_id, blocked });
        if (isActionFail(result)) {
          toast.danger(tError("code", { code: result.error }));
          return;
        }
        onSaved(result.key, null);
      } else {
        const result = await createKeyAction({ ...shared, days: Number(days) || 0 });
        if (isActionFail(result)) {
          toast.danger(tError("code", { code: result.error }));
          return;
        }
        const { key: secret, ...created } = result.key;
        onSaved(created, secret);
      }
      toast(t("toasts.saved", { mode: editing ? "updated" : "created" }), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-lg">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("dialogTitle", { mode: editing ? "edit" : "create" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  <TextField fullWidth isRequired value={alias} onChange={setAlias} isDisabled={pending}>
                    <Label>{t("fields.alias")}</Label>
                    <Input placeholder="prod-backend" />
                  </TextField>
                  <Select
                    selectedKey={teamId || "none"}
                    onSelectionChange={(key) => {
                      setTeamId(String(key) === "none" ? "" : String(key));
                      setProjectId("");
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
                        <ListBox.Item id="none" textValue={t("fields.personal")}>
                          {t("fields.personal")}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                        {options.teams.map((team) => (
                          <ListBox.Item key={team.id} id={team.id} textValue={team.alias}>
                            {team.alias}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <Select
                    selectedKey={projectId || "none"}
                    onSelectionChange={(key) => setProjectId(String(key) === "none" ? "" : String(key))}
                    isDisabled={pending}
                    fullWidth
                  >
                    <Label>{t("fields.project")}</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox aria-label={t("fields.project")}>
                        <ListBox.Item id="none" textValue={t("fields.noProject")}>
                          {t("fields.noProject")}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                        {projects.map((project) => (
                          <ListBox.Item key={project.id} id={project.id} textValue={project.alias}>
                            {project.alias}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <Separator />
                  <p className="text-sm font-medium text-foreground">{t("fields.access")}</p>
                  <MultiPicker
                    label={t("fields.templates")}
                    description={t.rich("fields.templatesHint", {
                      link: (chunks) => (
                        <Link href="/model-templates" className="text-accent">
                          {chunks}
                        </Link>
                      ),
                    })}
                    placeholder={t("fields.templatesPlaceholder")}
                    searchLabel={t("fields.search")}
                    emptyLabel={t("fields.noResults")}
                    items={options.templates.map((template) => ({
                      id: template.id,
                      label: template.name,
                      detail: [template.description, tTemplates("matchCount", { count: template.matches.length })]
                        .filter(Boolean)
                        .join(" · "),
                    }))}
                    selected={templateIds}
                    onChange={setTemplateIds}
                    isDisabled={pending}
                  />
                  <MultiPicker
                    label={t("fields.models")}
                    description={t("fields.modelsHint")}
                    placeholder={t("fields.modelsPlaceholder")}
                    searchLabel={t("fields.search")}
                    emptyLabel={t("fields.noResults")}
                    items={options.models.map((alias) => ({ id: alias, label: alias }))}
                    selected={models}
                    onChange={setModels}
                    isDisabled={pending}
                  />
                  {access === "none" ? (
                    <Alert status="warning">
                      <Alert.Content>
                        <Alert.Description>{t("access", { state: access, count: 0 })}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : (
                    <p className="text-sm text-muted">{t("access", { state: access, count: allowed.size })}</p>
                  )}
                  <Separator />
                  <div className="grid grid-cols-2 gap-3">
                    <TextField fullWidth value={rpm} onChange={setRpm} isDisabled={pending}>
                      <Label>{t("fields.rpm")}</Label>
                      <Input inputMode="numeric" />
                    </TextField>
                    <TextField fullWidth value={tpm} onChange={setTpm} isDisabled={pending}>
                      <Label>{t("fields.tpm")}</Label>
                      <Input inputMode="numeric" />
                    </TextField>
                  </div>
                  {editing ? null : (
                    <TextField fullWidth value={days} onChange={setDays} isDisabled={pending}>
                      <Label>{t("fields.days")}</Label>
                      <Input inputMode="numeric" />
                    </TextField>
                  )}
                  <TextField fullWidth value={ips} onChange={setIps} isDisabled={pending}>
                    <Label>{t("fields.allowedIps")}</Label>
                    <TextArea rows={3} placeholder="203.0.113.10" />
                    <Description>{t("fields.allowedIpsHint")}</Description>
                  </TextField>
                  <Switch isSelected={logContent} onChange={setLogContent} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("fields.logContent")}</Label>
                    </Switch.Content>
                    <Description>{t("fields.logContentHint")}</Description>
                  </Switch>
                  {editing ? (
                    <Switch isSelected={blocked} onChange={setBlocked} isDisabled={pending}>
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <Label>{t("fields.blocked")}</Label>
                      </Switch.Content>
                    </Switch>
                  ) : null}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!alias.trim()}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("dialogSubmit", { mode: editing ? "edit" : "create" })}
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
