"use client";

import { useState, useTransition } from "react";
import {
  Autocomplete,
  Button,
  Card,
  Chip,
  Description,
  EmptyState,
  Header,
  Label,
  ListBox,
  SearchField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  useFilter,
  type useOverlayState,
} from "@heroui/react";
import { FileJson, Link2, Server, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import IconTile from "@/components/console/icon-tile";
import { useErrorToast } from "@/components/console/use-error-toast";
import { kindIcon } from "@/components/providers/kind-icons";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { isActionFail } from "@/lib/http/action-result";
import type {
  AddProviderFilter,
  AddProviderOption,
  AddProviderPreset,
  AntigravityClientState,
  AuthFileSource,
  ImportOption,
  ProviderKindSpec,
  ProviderView,
  SignInKind,
} from "@/types/providers";
import { createProviderAction } from "../_action";
import AntigravitySetup from "./antigravity-setup";
import { draftBody, draftFor, draftReady } from "./provider-draft";
import ProviderFields from "./provider-fields";
import { ADD_PROVIDER_FILTERS, kindSearchText, providerOptions, sectionsFor } from "./provider-options";

const IMPORT_ICONS = { files: FileJson, server: Server, link: Link2 } as const satisfies Record<ImportOption, LucideIcon>;

function stayInSearch() {
  return undefined;
}

export default function AddProviderDialog({
  state,
  preset,
  rows,
  antigravity,
  onAntigravity,
  onImport,
  onShare,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  preset: AddProviderPreset;
  rows: ProviderView[];
  antigravity: AntigravityClientState | null;
  onAntigravity: (state: AntigravityClientState) => void;
  onImport: (source: AuthFileSource) => void;
  onShare: (kind: SignInKind | null) => void;
  onSaved: (provider: ProviderView, superseded: string[]) => void;
}) {
  const t = useTranslations("Providers");
  const tPicker = useTranslations("Providers.picker");
  const tSettings = useTranslations("Subscriptions.settings");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const { contains } = useFilter({ sensitivity: "base" });
  const presetSpec = PROVIDER_CATALOG.find((spec) => spec.kind === preset.kind) ?? null;
  const [filter, setFilter] = useState<AddProviderFilter>(preset.filter);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(presetSpec?.kind ?? null);
  const [spec, setSpec] = useState<ProviderKindSpec | null>(presetSpec);
  const [draft, setDraft] = useState(() =>
    draftFor(presetSpec, null, presetSpec ? t("kindName", { kind: presetSpec.kind }) : ""),
  );
  const [pending, start] = useTransition();
  const sections = sectionsFor(filter);
  const choice = sections.flatMap(providerOptions).find((option) => option.id === picked) ?? null;
  const antigravityReady = antigravity === null ? null : antigravity.saved || antigravity.bundled;
  const needsSetup = (kind: string) => kind === "antigravity" && antigravityReady === false;
  const kindText = (key: "kindName" | "kindShort" | "kindDescription", kind: string) => t(key, { kind });

  function proceed(close: () => void) {
    if (spec) {
      connect(spec, close);
      return;
    }
    if (!choice) return;
    if (choice.section !== "import") {
      setSpec(choice.spec);
      setDraft(draftFor(choice.spec, null, t("kindName", { kind: choice.spec.kind })));
      return;
    }
    close();
    if (choice.option === "link") onShare(null);
    else onImport(choice.option);
  }

  function connect(target: ProviderKindSpec, close: () => void) {
    const body = draftBody(target, draft);
    start(async () => {
      const result = await createProviderAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.provider, result.superseded);
      toast(t("toasts.saved", { mode: result.outcome }), { variant: "success" });
      close();
    });
  }

  function shareInstead(kind: SignInKind) {
    state.close();
    onShare(kind);
  }

  function optionItem(option: AddProviderOption) {
    if (option.section === "import") {
      const label = tPicker("import", { option: option.option });
      const hint = tPicker("importHint", { option: option.option });
      return (
        <ListBox.Item key={option.id} id={option.id} textValue={`${label} ${hint}`}>
          <IconTile icon={IMPORT_ICONS[option.option]} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Label>{label}</Label>
            <Description className="line-clamp-2">{hint}</Description>
          </div>
          <ListBox.ItemIndicator />
        </ListBox.Item>
      );
    }
    const { kind } = option.spec;
    const count = rows.filter((row) => row.kind === kind).length;
    const locked = needsSetup(kind);
    return (
      <ListBox.Item key={option.id} id={option.id} textValue={kindSearchText(kind, kindText)}>
        <IconTile icon={kindIcon(kind)} tone={locked ? "neutral" : "accent"} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Label>{t("kindName", { kind })}</Label>
          <Description className="line-clamp-2">{t("kindDescription", { kind })}</Description>
        </div>
        {locked ? (
          <Chip size="sm" variant="soft" color="warning" className="shrink-0 whitespace-nowrap">
            {tSettings("setupRequired")}
          </Chip>
        ) : count > 0 ? (
          <Chip size="sm" variant="soft" className="shrink-0 whitespace-nowrap">
            {tPicker("connected", { count })}
          </Chip>
        ) : null}
        <ListBox.ItemIndicator />
      </ListBox.Item>
    );
  }

  const signInKind = spec && isSignInKind(spec.kind) ? spec.kind : null;

  return (
    <FormDialog
      state={state}
      size="md"
      title={tPicker("title")}
      description={spec ? undefined : tPicker("description")}
      submitLabel={spec ? t("formSubmit", { mode: "connect" }) : tCommon("continue")}
      pending={pending}
      isSubmitDisabled={spec ? needsSetup(spec.kind) || !draftReady(spec, null, draft) : choice === null}
      onSubmit={proceed}
    >
      {spec ? (
        <>
          <Card variant="secondary">
            <Card.Header className="flex-row items-center gap-3">
              <IconTile icon={kindIcon(spec.kind)} />
              <div className="min-w-0 flex-1">
                <Card.Title className="break-words">{t("kindName", { kind: spec.kind })}</Card.Title>
                <Card.Description>
                  {t("poolHint", { pool: signInKind ? "subscription" : draft.internal ? "internal" : "api" })}
                </Card.Description>
              </div>
              <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => setSpec(null)}>
                {tPicker("change")}
              </Button>
            </Card.Header>
            {signInKind ? (
              <Card.Footer className="flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 basis-48 text-sm text-muted">{tPicker("linkHint")}</p>
                <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => shareInstead(signInKind)}>
                  <Link2 size={14} aria-hidden />
                  {tPicker("linkInstead")}
                </Button>
              </Card.Footer>
            ) : null}
          </Card>
          {needsSetup(spec.kind) ? (
            <AntigravitySetup state={antigravity} onChanged={onAntigravity} />
          ) : (
            <ProviderFields spec={spec} editing={null} draft={draft} isDisabled={pending} onChange={setDraft} />
          )}
        </>
      ) : (
        <>
          <ToggleButtonGroup
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            aria-label={tPicker("filterLabel")}
            selectedKeys={[filter]}
            onSelectionChange={(keys) => {
              const next = ADD_PROVIDER_FILTERS.find((item) => item === [...keys][0]);
              if (next) setFilter(next);
            }}
          >
            {ADD_PROVIDER_FILTERS.map((item, index) => (
              <ToggleButton key={item} id={item}>
                {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                {tPicker("filter", { filter: item })}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Autocomplete.Filter filter={contains} inputValue={search} onInputChange={setSearch}>
            <SearchField autoFocus fullWidth aria-label={tPicker("search")} variant="secondary" onSubmit={stayInSearch}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={tPicker("searchPlaceholder")} />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <ListBox
              aria-label={tPicker("listLabel")}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={choice ? [choice.id] : []}
              onSelectionChange={(keys) => {
                if (keys === "all") return;
                const [next] = [...keys];
                if (next !== undefined) setPicked(String(next));
              }}
              renderEmptyState={() => <EmptyState>{tCommon("noResults")}</EmptyState>}
              className="max-h-96 overflow-y-auto"
            >
              {sections.map((section) => (
                <ListBox.Section key={section} id={section}>
                  <Header>{tPicker("section", { section })}</Header>
                  {providerOptions(section).map(optionItem)}
                </ListBox.Section>
              ))}
            </ListBox>
          </Autocomplete.Filter>
        </>
      )}
    </FormDialog>
  );
}
