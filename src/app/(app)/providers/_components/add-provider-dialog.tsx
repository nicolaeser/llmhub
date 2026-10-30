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
  Radio,
  RadioGroup,
  SearchField,
  toast,
  useFilter,
  type useOverlayState,
} from "@heroui/react";
import { FileJson, KeyRound, Link2, Server, Upload, UserRound, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import StepDialog, { type DialogStep } from "@/components/console/step-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { kindIcon } from "@/components/providers/kind-icons";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { isActionFail } from "@/lib/http/action-result";
import type {
  AddProviderOption,
  AddProviderPreset,
  AddProviderSection,
  AntigravityClientState,
  AuthFileSource,
  ImportOption,
  ProviderKindSpec,
  ProviderView,
  SignInKind,
} from "@/types/providers";
import { createProviderAction } from "../_action";
import AntigravitySetup from "./antigravity-setup";
import { draftBody, draftFor, draftReady, retentionValid } from "./provider-draft";
import { ConnectionFields, DataHandlingFields, ModelSettingsFields } from "./provider-fields";
import { ADD_PROVIDER_SECTIONS, filterOf, kindSearchText, optionById, providerOptions } from "./provider-options";

const IMPORT_ICONS = { files: FileJson, server: Server, link: Link2 } as const satisfies Record<ImportOption, LucideIcon>;

const TYPE_ICONS = { api: KeyRound, subscription: UserRound, import: Upload } as const satisfies Record<
  AddProviderSection,
  LucideIcon
>;

function stayInSearch() {
  return undefined;
}

function initialType(preset: AddProviderPreset): AddProviderSection | null {
  if (preset.kind) return filterOf(preset.kind);
  return preset.filter === "all" ? null : preset.filter;
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
  const tAdd = useTranslations("Providers.add");
  const tPicker = useTranslations("Providers.picker");
  const tSettings = useTranslations("Subscriptions.settings");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const { contains } = useFilter({ sensitivity: "base" });
  const presetSpec = PROVIDER_CATALOG.find((spec) => spec.kind === preset.kind) ?? null;
  const [type, setType] = useState<AddProviderSection | null>(() => initialType(preset));
  const [locked, setLocked] = useState(presetSpec !== null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(presetSpec?.kind ?? null);
  const [draft, setDraft] = useState(() =>
    draftFor(presetSpec, null, presetSpec ? t("kindName", { kind: presetSpec.kind }) : ""),
  );
  const [pending, start] = useTransition();
  const choice = optionById(picked);
  const spec = choice && choice.section !== "import" ? choice.spec : null;
  const antigravityReady = antigravity === null ? null : antigravity.saved || antigravity.bundled;
  const needsSetup = (kind: string) => kind === "antigravity" && antigravityReady === false;
  const kindText = (key: "kindName" | "kindShort" | "kindDescription", kind: string) => t(key, { kind });
  const signInKind = spec && isSignInKind(spec.kind) ? spec.kind : null;

  function chooseType(next: AddProviderSection) {
    setType(next);
    if (choice && choice.section !== next) setPicked(null);
  }

  function pick(id: string) {
    const option = optionById(id);
    setPicked(id);
    if (option && option.section !== "import") {
      setDraft(draftFor(option.spec, null, t("kindName", { kind: option.spec.kind })));
    }
  }

  function submit(close: () => void) {
    if (choice?.section === "import") {
      close();
      if (choice.option === "link") onShare(null);
      else onImport(choice.option);
      return;
    }
    if (spec) connect(spec, close);
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
    const setup = needsSetup(kind);
    return (
      <ListBox.Item key={option.id} id={option.id} textValue={kindSearchText(kind, kindText)}>
        <IconTile icon={kindIcon(kind)} tone={setup ? "neutral" : "accent"} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Label>{t("kindName", { kind })}</Label>
          <Description className="line-clamp-2">{t("kindDescription", { kind })}</Description>
        </div>
        {setup ? (
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

  const typeStep: DialogStep = {
    id: "type",
    title: tAdd("step", { step: "type" }),
    description: tAdd("stepHint", { step: "type" }),
    isValid: type !== null,
    content: (
      <RadioGroup
        value={type ?? ""}
        onChange={(next) => {
          const section = ADD_PROVIDER_SECTIONS.find((item) => item === next);
          if (section) chooseType(section);
        }}
        aria-label={tAdd("typeLabel")}
        className="grid gap-3"
      >
        {ADD_PROVIDER_SECTIONS.map((section) => {
          const selected = type === section;
          return (
            <Card
              key={section}
              variant="secondary"
              className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
            >
              <Radio value={section} className="mt-0 h-full w-full">
                <Radio.Content className="h-full w-full items-start gap-3 p-4">
                  <IconTile icon={TYPE_ICONS[section]} tone={selected ? "accent" : "neutral"} />
                  <span className="min-w-0 flex-1 space-y-1">
                    <Label>{tAdd("type", { type: section })}</Label>
                    <span className="block text-sm font-normal text-muted">{tAdd("typeHint", { type: section })}</span>
                  </span>
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                </Radio.Content>
              </Radio>
            </Card>
          );
        })}
      </RadioGroup>
    ),
  };

  const providerStep: DialogStep = {
    id: "provider",
    title: tAdd("step", { step: type === "import" ? "source" : "provider" }),
    description: tAdd("stepHint", { step: type === "import" ? "source" : "provider" }),
    isValid: choice !== null && choice.section === type,
    content: (
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
            if (next !== undefined) pick(String(next));
          }}
          renderEmptyState={() => <EmptyState>{tCommon("noResults")}</EmptyState>}
          className="max-h-96 overflow-y-auto"
        >
          {type ? (
            <ListBox.Section id={type}>
              <Header>{tPicker("section", { section: type })}</Header>
              {providerOptions(type).map(optionItem)}
            </ListBox.Section>
          ) : null}
        </ListBox>
      </Autocomplete.Filter>
    ),
  };

  const connectStep: DialogStep = {
    id: "connect",
    title: tAdd("step", { step: "connect" }),
    description:
      spec && !signInKind ? t("form.connectionHint", { method: spec.kind === "vertex" ? "vertex" : "apiKey" }) : undefined,
    isValid: spec !== null && !needsSetup(spec.kind) && draftReady(spec, null, draft),
    content: spec ? (
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
            {locked ? (
              <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => setLocked(false)}>
                {tPicker("change")}
              </Button>
            ) : null}
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
          <ConnectionFields spec={spec} editing={null} draft={draft} isDisabled={pending} onChange={setDraft} bare />
        )}
      </>
    ) : null,
  };

  const dataStep: DialogStep = {
    id: "data",
    title: tAdd("step", { step: "data" }),
    description: t("dataHandling.hint"),
    optional: true,
    isValid: retentionValid(draft),
    content: <DataHandlingFields draft={draft} isDisabled={pending} onChange={setDraft} bare />,
  };

  const modelsStep: DialogStep = {
    id: "models",
    title: tAdd("step", { step: "models" }),
    description: spec ? t("form.modelsHint", { method: signInKind ? "signIn" : "apiKey" }) : undefined,
    optional: true,
    content: spec ? <ModelSettingsFields spec={spec} draft={draft} isDisabled={pending} onChange={setDraft} bare /> : null,
  };

  const steps =
    type === "import"
      ? [typeStep, providerStep]
      : locked
        ? [connectStep, dataStep, modelsStep]
        : [typeStep, providerStep, connectStep, dataStep, modelsStep];

  return (
    <StepDialog
      state={state}
      size="lg"
      title={tPicker("title")}
      description={tAdd("description")}
      steps={steps}
      submitLabel={type === "import" ? tCommon("continue") : t("formSubmit", { mode: "connect" })}
      pending={pending}
      onSubmit={submit}
    />
  );
}
