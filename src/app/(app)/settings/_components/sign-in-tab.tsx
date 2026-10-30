"use client";

import { useRef, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Disclosure,
  Input,
  Label,
  Separator,
  Spinner,
  TextField,
  toast,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { SettingSection, SettingSwitch, SettingText } from "./setting-fields";
import { useErrorToast } from "@/components/console/use-error-toast";
import {
  entraV2Issuer,
  issuerHasPlaceholder,
  issuerHost,
  OIDC_PRESETS,
  OIDC_PROVIDER_IDS,
  providerName,
  suggestedIssuer,
} from "@/lib/auth/oidc-presets";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { OidcProviderId, OidcSettings } from "@/types/auth";
import type { IssuerCheck, SignInSettingsView } from "@/types/settings";
import { checkOidcIssuerAction, loadSignInSettingsAction, saveSignInSettingsAction } from "../_action";
import OptionSelect from "./option-select";
import ProviderRoles, { type Detection } from "./provider-roles";
import RoleMappings, { type MappingRow } from "./role-mappings";
import SaveBar, { SettingsLead } from "./save-bar";
import ScimSection from "./scim-section";
import TabState from "./tab-state";

type Draft = { oidc: OidcSettings; rows: MappingRow[]; domains: string };

const NONE = "none";

const DETECT_DELAY_MS = 700;

function draftOf(view: SignInSettingsView): Draft {
  return {
    oidc: view.oidc,
    rows: view.oidc.role_mappings.map((mapping, index) => ({ ...mapping, key: `saved-${index}` })),
    domains: view.oidc.allowed_domains.join(", "),
  };
}

function checkState(check: IssuerCheck) {
  if (check.ok) return check.supported ? "ok" : "unsupported";
  if (check.reason === "issuer_mismatch" && check.issuer && entraV2Issuer(check.issuer)) return "entra_v1";
  return check.reason;
}

function detectable(issuer: string) {
  return URL.canParse(issuer) && /^https?:/i.test(issuer) && !issuerHasPlaceholder(issuer);
}

function CopyUrl({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Card variant="secondary" className="min-w-0 flex-1">
        <Card.Content>
          <code className="font-mono text-xs break-all">{url}</code>
        </Card.Content>
      </Card>
      <CopyButton text={url} label={label} variant="secondary" />
    </div>
  );
}

function checkSuggestion(check: IssuerCheck) {
  if (check.ok) return check.usesTenantId ? check.issuer : null;
  return check.reason === "issuer_mismatch" && check.issuer ? suggestedIssuer(check.issuer) : null;
}

export default function SignInTab() {
  const t = useTranslations("Settings.signIn");
  const tSettings = useTranslations("Settings");
  const tRoles = useTranslations("Roles");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [check, setCheck] = useState<IssuerCheck | null>(null);
  const [pending, start] = useTransition();
  const [checking, startCheck] = useTransition();
  const ticket = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [roleFieldsTouched, setRoleFieldsTouched] = useState(false);

  function detect(issuer: string, quiet: boolean) {
    const run = ++ticket.current;
    startCheck(async () => {
      const result = await checkOidcIssuerAction({ issuer });
      if (run !== ticket.current) return;
      if (isActionFail(result)) {
        if (!quiet) showError(result.error);
        return;
      }
      setCheck(result);
    });
  }

  const page = useActionData(loadSignInSettingsAction, (loaded) => {
    if (detectable(loaded.oidc.issuer)) detect(loaded.oidc.issuer, true);
  });
  const { data: view, setData } = page;

  if (!view) return <TabState state={page} />;

  const current = draft ?? draftOf(view);
  const oidc = current.oidc;
  const disabled = !view.canManage || pending;
  const update = (patch: Partial<Draft>) => setDraft({ ...current, ...patch });
  const setOidc = (patch: Partial<OidcSettings>) => update({ oidc: { ...oidc, ...patch } });
  const touchRoles = () => setRoleFieldsTouched(true);
  const preset = OIDC_PRESETS[oidc.provider];
  const ready = oidc.enabled && Boolean(oidc.issuer && oidc.client_id) && view.secretSet;
  const roleLabel = (role: SignInSettingsView["roles"][number]) =>
    role.templateKey ? tRoles("templateName", { key: role.templateKey }) : (role.name ?? role.id);
  const used = new Set([...current.rows.map((row) => row.role_id), oidc.default_role_id]);
  const roles = view.roles
    .filter((role) => role.assignable || used.has(role.id))
    .map((role) => ({ id: role.id, label: roleLabel(role) }));
  const appRoles = view.oidc.app_roles;
  const detection: Detection = checking ? "checking" : check?.ok ? (check.appRoles ? "offered" : "absent") : "unknown";

  function scheduleDetect(issuer: string) {
    if (timer.current) clearTimeout(timer.current);
    ticket.current += 1;
    if (!detectable(issuer)) return;
    timer.current = setTimeout(() => detect(issuer, true), DETECT_DELAY_MS);
  }

  function changeIssuer(issuer: string, patch: Partial<OidcSettings> = {}) {
    setOidc({ ...patch, issuer });
    setCheck(null);
    scheduleDetect(issuer);
  }

  function pickProvider(provider: OidcProviderId) {
    const next = OIDC_PRESETS[provider];
    const fixedIssuer = next.issuer && !issuerHasPlaceholder(next.issuer) ? next.issuer : "";
    const keptIssuer = oidc.issuer === preset.issuer ? "" : oidc.issuer;
    changeIssuer(fixedIssuer || keptIssuer, { provider, scopes: next.scopes, groups_claim: next.groupsClaim });
  }

  function runCheck(issuer = oidc.issuer) {
    if (timer.current) clearTimeout(timer.current);
    detect(issuer, false);
  }

  function save() {
    start(async () => {
      const result = await saveSignInSettingsAction({
        ...oidc,
        role_mappings: current.rows.map(({ group, role_id }) => ({ group, role_id })),
        allowed_domains: current.domains.split(/[\s,;]+/).filter(Boolean),
        role_fields_touched: roleFieldsTouched,
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      setDraft(null);
      toast(tSettings("saved"), { variant: "success" });
    });
  }

  function applyIssuer(issuer: string) {
    setOidc({ issuer });
    setCheck(null);
    runCheck(issuer);
  }

  const suggestion = check ? checkSuggestion(check) : null;
  const checklist = [
    { key: "callback", ok: null },
    { key: "logout", ok: null },
    { key: "secret", ok: view.secretSet },
    { key: "client", ok: Boolean(oidc.issuer && oidc.client_id) },
    { key: "issuer", ok: check ? check.ok && check.supported : null },
    { key: "enabled", ok: oidc.enabled },
  ] as const;

  return (
    <div className="space-y-8">
      <SettingsLead description={t("description")} canManage={view.canManage} />

      <SettingSection title={t("sso.title")} subtitle={t("sso.subtitle")}>
        <div className="flex flex-col gap-3">
          <SettingSwitch
            label={t("sso.enabled")}
            isSelected={oidc.enabled}
            onChange={(enabled) => setOidc({ enabled })}
            isDisabled={disabled}
            hint={t("sso.enabledHint", { ready: view.secretSet ? "true" : "false" })}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <OptionSelect
            label={t("sso.provider")}
            value={oidc.provider}
            options={OIDC_PROVIDER_IDS.map((id) => ({
              id,
              label: t("presets.name", { id }),
              description: t("presets.note", { id }),
            }))}
            onChange={pickProvider}
            isDisabled={disabled}
            description={t("presets.note", { id: oidc.provider })}
          />
          <div className="space-y-2">
            <SettingText
              label={t("sso.issuer")}
              value={oidc.issuer}
              onChange={(issuer) => changeIssuer(issuer)}
              isDisabled={disabled}
              placeholder={preset.issuer || "https://login.example.com/realms/acme"}
              hint={t("sso.issuerHint")}
            />
            {view.canManage ? (
              <Button
                size="sm"
                variant="secondary"
                isPending={checking}
                isDisabled={!oidc.issuer || issuerHasPlaceholder(oidc.issuer)}
                onPress={() => runCheck()}
              >
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : null}
                    {t("sso.check")}
                  </>
                )}
              </Button>
            ) : null}
          </div>
          <SettingText
            label={t("sso.clientId")}
            value={oidc.client_id}
            onChange={(client_id) => setOidc({ client_id })}
            isDisabled={disabled}
          />
          <SettingText
            label={t("sso.displayName")}
            value={oidc.display_name}
            onChange={(display_name) => setOidc({ display_name })}
            isDisabled={disabled}
            placeholder={issuerHost(oidc.issuer) || t("sso.displayNamePlaceholder")}
            hint={t("sso.displayNameHint")}
          />
          <SettingText
            label={t("sso.scopes")}
            value={oidc.scopes}
            onChange={(scopes) => setOidc({ scopes })}
            isDisabled={disabled}
            hint={t("sso.scopesHint")}
          />
        </div>
        {check ? (
          <Alert status={check.ok ? (check.supported ? "success" : "warning") : "danger"}>
            <Alert.Indicator />
            <Alert.Content className="min-w-0">
              <Alert.Title>{t("check.title", { state: checkState(check) })}</Alert.Title>
              <Alert.Description className="break-words">
                {check.ok
                  ? t("check.found", {
                      issuer: check.issuer,
                      method: check.tokenAuth,
                      algorithms: check.algorithms.join(", ") || "RS256",
                    })
                  : t("check.failed", {
                      reason: checkState(check),
                      status: check.status ?? 0,
                      issuer: check.issuer ?? "",
                      suggestion: suggestion ?? "",
                    })}
                {check.ok && check.usesTenantId ? ` ${t("check.tenantId", { issuer: check.issuer })}` : null}
              </Alert.Description>
            </Alert.Content>
            {suggestion && view.canManage ? (
              <Button size="sm" variant="secondary" isDisabled={disabled || checking} onPress={() => applyIssuer(suggestion)}>
                {t("check.useIssuer")}
              </Button>
            ) : null}
          </Alert>
        ) : null}
        {preset.docs ? (
          <a href={preset.docs} target="_blank" rel="noreferrer noopener" className="text-sm font-medium text-accent">
            {t("presets.docs", { id: oidc.provider })}
          </a>
        ) : null}
      </SettingSection>

      {oidc.issuer ? (
        <ProviderRoles
          view={view}
          provider={providerName(oidc)}
          detection={detection}
          dirty={draft !== null}
          turnsOnWhenSaved={view.firstSetup && !roleFieldsTouched}
          onSaved={setData}
        />
      ) : null}

      <SettingSection title={t("checklist.title")} subtitle={t("checklist.subtitle")}>
        <div className="flex flex-col gap-3">
          <ol className="min-w-0 flex-1 divide-y divide-border">
            {checklist.map((item, index) => (
              <li key={item.key} className="space-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    {t("checklist.step", { step: item.key, position: index + 1 })}
                  </span>
                  {item.ok === null ? null : (
                    <Chip size="sm" variant="soft" color={item.ok ? "success" : "warning"}>
                      {t("checklist.state", { ok: item.ok ? "true" : "false" })}
                    </Chip>
                  )}
                </div>
                {item.key === "callback" ? <CopyUrl url={view.callbackUrl} label={t("checklist.copyCallback")} /> : null}
                {item.key === "logout" ? (
                  <>
                    <CopyUrl url={view.backchannelLogoutUrl} label={t("checklist.copyLogout")} />
                    <p className="text-xs text-muted">{t("checklist.logoutHint")}</p>
                  </>
                ) : null}
                {item.key === "secret" ? (
                  <p className="text-xs text-muted">{t("checklist.secretHint")}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </SettingSection>

      <SettingSection title={t("accounts.title")} subtitle={t("accounts.subtitle")}>
        <div className="flex flex-col gap-3">
          <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-2 md:items-start">
            <OptionSelect
              label={t("accounts.defaultRole")}
              value={oidc.default_role_id || NONE}
              options={[{ id: NONE, label: t("accounts.noDefault", { appRoles: appRoles ? "true" : "false" }) }, ...roles]}
              onChange={(id) => {
                touchRoles();
                setOidc({ default_role_id: id === NONE ? "" : id });
              }}
              isDisabled={disabled}
              description={t("accounts.defaultRoleHint", { appRoles: appRoles ? "true" : "false" })}
            />
            <OptionSelect
              label={t("accounts.defaultCompany")}
              value={oidc.default_org_id || NONE}
              options={[
                { id: NONE, label: t("accounts.platform") },
                ...view.orgs.map((org) => ({ id: org.id, label: org.alias })),
              ]}
              onChange={(id) => setOidc({ default_org_id: id === NONE ? "" : id })}
              isDisabled={disabled}
              description={t("accounts.defaultCompanyHint")}
            />
            <TextField
              fullWidth
              value={current.domains}
              onChange={(domains) => update({ domains })}
              isDisabled={disabled}
              className="md:col-span-2"
            >
              <Label>{t("accounts.domains")}</Label>
              <Input placeholder="example.com, example.org" />
              <Description>{t("accounts.domainsHint")}</Description>
            </TextField>
          </div>
        </div>
        <Separator />
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t("mapping.title")}</h3>
            <p className="text-sm text-muted">{t("mapping.subtitle")}</p>
          </div>
          <SettingText
            label={t("mapping.claim")}
            value={oidc.groups_claim}
            onChange={(groups_claim) => {
              touchRoles();
              setOidc({ groups_claim });
            }}
            isDisabled={disabled}
            placeholder={preset.groupsClaim || "groups"}
            hint={t("mapping.claimHint")}
          />
          <RoleMappings
            rows={current.rows}
            roles={roles}
            appRoles={appRoles}
            canEdit={view.canManage}
            isDisabled={disabled}
            onChange={(rows) => {
              touchRoles();
              update({ rows });
            }}
          />
        </div>
      </SettingSection>

      <SettingSection title={t("ssoOnly.title")} subtitle={t("ssoOnly.subtitle")}>
        <div className="flex flex-col gap-3">
          <SettingSwitch
            label={t("ssoOnly.enabled")}
            isSelected={oidc.sso_only}
            onChange={(sso_only) => setOidc({ sso_only })}
            isDisabled={disabled || (!oidc.sso_only && !ready)}
            hint={t("ssoOnly.hint", { ready: ready ? "true" : "false" })}
          />
        </div>
      </SettingSection>

      <ScimSection
        initiallySet={view.scimTokenSet}
        canManage={view.canManageScim}
        groups={view.scimGroups}
        baseUrl={view.scimUrl}
      />

      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm text-muted">
            {t("matching.title")}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="pt-3 text-sm text-muted">{t("matching.body")}</Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
      <SaveBar canManage={view.canManage} pending={pending} onSave={save} />
    </div>
  );
}
