"use client";

import { useId, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  Modal,
  Separator,
  Spinner,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import { createKeyAction, updateKeyAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import { accessWindowValid, KEY_ENDPOINTS } from "@/lib/gateway/key-restrictions";
import type { AccessWindowDraft, KeyBindingKind, KeyEndpoint, KeyOptions, KeyPreset } from "@/types/keys";
import type { VirtualKeyView } from "@/types/gateway";
import AccessWindowFields from "./access-window-fields";
import { bindingKind, placeOf } from "./key-binding";

const KINDS: KeyBindingKind[] = ["project", "member", "internal"];

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function initialKind(
  editing: VirtualKeyView | null,
  preset: KeyPreset | null,
  options: KeyOptions,
  canBind: boolean,
): KeyBindingKind {
  if (editing) return bindingKind(editing);
  if (!canBind) return "internal";
  if (preset) return preset.kind;
  return options.projects.length || options.members.length ? "project" : "internal";
}

export function KeyDialog({
  state,
  editing,
  preset,
  options,
  canBind,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: VirtualKeyView | null;
  preset: KeyPreset | null;
  options: KeyOptions;
  canBind: boolean;
  onSaved: (key: VirtualKeyView, secret: string | null) => void;
}) {
  const t = useTranslations("Keys");
  const tTemplates = useTranslations("ModelTemplates");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const bindingLabel = useId();
  const [alias, setAlias] = useState(editing?.key_alias ?? "");
  const [kind, setKind] = useState<KeyBindingKind>(() => initialKind(editing, preset, options, canBind));
  const [projectId, setProjectId] = useState(
    editing?.project_id ?? (preset?.kind === "project" ? preset.id : ""),
  );
  const [memberId, setMemberId] = useState(
    editing?.member_id ?? (preset?.kind === "member" ? preset.id : ""),
  );
  const [models, setModels] = useState<string[]>(editing?.models ?? []);
  const [templateIds, setTemplateIds] = useState<string[]>(editing?.templates ?? []);
  const [rpm, setRpm] = useState(String(editing?.rpm_limit ?? 0));
  const [tpm, setTpm] = useState(String(editing?.tpm_limit ?? 0));
  const [days, setDays] = useState("");
  const [ips, setIps] = useState((editing?.allowed_ips ?? []).join("\n"));
  const [endpoints, setEndpoints] = useState<KeyEndpoint[]>(editing?.allowed_endpoints ?? []);
  const [windows, setWindows] = useState<AccessWindowDraft[]>(
    () => editing?.access_windows.map((w, i) => ({ ...w, key: i + 1 })) ?? [],
  );
  const [timeZone, setTimeZone] = useState(editing?.access_time_zone ?? "UTC");
  const [blocked, setBlocked] = useState(editing?.blocked ?? false);
  const [logContent, setLogContent] = useState(editing?.log_content ?? true);
  const [pending, start] = useTransition();
  const targets = kind === "project" ? options.projects : options.members;
  const targetId = kind === "project" ? projectId : memberId;
  const bound = kind === "internal" || Boolean(targetId);
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
        projectId: kind === "project" ? projectId : "",
        memberId: kind === "member" ? memberId : "",
        models,
        templateIds,
        rpm: Number(rpm) || 0,
        tpm: Number(tpm) || 0,
        allowedIps: splitList(ips),
        allowedEndpoints: endpoints,
        accessWindows: windows.map(({ days, start, end }) => ({ days, start, end })),
        accessTimeZone: timeZone,
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
                  <div className="space-y-2">
                    <p id={bindingLabel} className="text-sm font-medium text-foreground">
                      {t("fields.binding")}
                    </p>
                    <ToggleButtonGroup
                      fullWidth
                      selectionMode="single"
                      disallowEmptySelection
                      aria-labelledby={bindingLabel}
                      selectedKeys={[kind]}
                      onSelectionChange={(keys) => {
                        const next = KINDS.find((item) => item === [...keys][0]);
                        if (next) setKind(next);
                      }}
                      isDisabled={pending || !canBind}
                    >
                      {KINDS.map((item, index) => (
                        <ToggleButton key={item} id={item}>
                          {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                          {t("binding.kind", { kind: item })}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                    <p className="text-xs text-muted">
                      {canBind
                        ? t("binding.hint", { kind, scope: options.companyId ? "company" : "platform" })
                        : t("binding.locked")}
                    </p>
                  </div>
                  {kind === "internal" ? null : (
                    <SearchSelect
                      isRequired
                      label={t("binding.kind", { kind })}
                      placeholder={t("binding.pick", { kind })}
                      items={targets.map((target) => {
                        const place = placeOf(options, target.orgId, target.teamId);
                        return {
                          id: target.id,
                          label: target.alias,
                          detail: t("binding.place", {
                            org: place.org,
                            team: place.team,
                            hasTeam: place.team ? "yes" : "no",
                          }),
                        };
                      })}
                      value={targetId}
                      onChange={(next) => {
                        if (kind === "project") setProjectId(next);
                        else setMemberId(next);
                      }}
                      isDisabled={pending || !canBind || targets.length === 0}
                      description={
                        targets.length
                          ? t("binding.targetHint", { kind })
                          : t.rich("binding.empty", {
                              kind,
                              link: (chunks) => (
                                <Link href="/companies" className="text-accent">
                                  {chunks}
                                </Link>
                              ),
                            })
                      }
                    />
                  )}
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
                  <MultiPicker
                    label={t("fields.endpoints")}
                    description={t("fields.endpointsHint")}
                    placeholder={t("fields.endpointsPlaceholder")}
                    searchLabel={t("fields.search")}
                    emptyLabel={t("fields.noResults")}
                    items={KEY_ENDPOINTS.map((endpoint) => ({
                      id: endpoint,
                      label: t("endpoints.name", { endpoint }),
                      detail: t("endpoints.paths", { endpoint }),
                    }))}
                    selected={endpoints}
                    onChange={(ids) => setEndpoints(KEY_ENDPOINTS.filter((endpoint) => ids.includes(endpoint)))}
                    isDisabled={pending}
                  />
                  <AccessWindowFields
                    windows={windows}
                    timeZone={timeZone}
                    isDisabled={pending}
                    onWindowsChange={setWindows}
                    onTimeZoneChange={setTimeZone}
                  />
                  <Separator />
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
                    isDisabled={!alias.trim() || !bound || !windows.every(accessWindowValid)}
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
