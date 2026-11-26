"use client";

import { useState, useTransition } from "react";
import { Alert, Description, Input, Label, TextField, toast, type useOverlayState } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { mediaToolsAt } from "@/lib/mcp/media-tools";
import type { McpAccessLevel, McpMediaKind, McpMediaModel, McpServerView } from "@/types/mcp";
import { createMediaMcpServerAction, updateMediaMcpServerAction } from "../_action";
import { DefaultAccessSelect } from "./access-fields";

const NONE = "media:none";
const KINDS: readonly McpMediaKind[] = ["image", "speech", "video", "transcription"];

type ModelPicks = Record<McpMediaKind, string>;

function picksOf(server: McpServerView | null, models: McpMediaModel[]): ModelPicks {
  if (server?.media) {
    return {
      image: server.media.image.model,
      speech: server.media.speech.model,
      video: server.media.video.model,
      transcription: server.media.transcription.model,
    };
  }
  const first = (kind: McpMediaKind) => models.find((model) => model.kinds.includes(kind))?.alias ?? "";
  return { image: first("image"), speech: first("speech"), video: first("video"), transcription: first("transcription") };
}

export default function MediaDialog({
  state,
  editing,
  models,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: McpServerView | null;
  models: McpMediaModel[];
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const format = useFormatter();
  const showError = useErrorToast();
  const [name, setName] = useState(editing?.name ?? "media");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [picks, setPicks] = useState<ModelPicks>(() => picksOf(editing, models));
  const [voice, setVoice] = useState(editing?.media?.speech.voice ?? "");
  const [defaultAccess, setDefaultAccess] = useState<McpAccessLevel>(editing?.defaultAccess ?? "none");
  const [pending, start] = useTransition();
  const mode = editing ? "edit" : "add";
  const known = new Set(models.map((model) => model.alias));
  const everyone = mediaToolsAt(defaultAccess, KINDS.filter((kind) => picks[kind]));
  const none = { id: NONE, label: t("media.none") };

  function itemsFor(kind: McpMediaKind) {
    const fitting = models.filter((model) => model.kinds.includes(kind));
    const others = models.filter((model) => !model.kinds.includes(kind));
    const items = [
      ...fitting.map((model) => ({ id: model.alias, label: model.label || model.alias, detail: t("media.fits", { kind }) })),
      ...others.map((model) => ({ id: model.alias, label: model.label || model.alias })),
    ];
    const saved = editing?.media?.[kind].model ?? "";
    if (!saved || known.has(saved)) return [none, ...items];
    return [none, { id: saved, label: saved, detail: t("media.unavailableModel") }, ...items];
  }

  function save(close: () => void) {
    start(async () => {
      const input = {
        name: name.trim(),
        description: description.trim(),
        imageModel: picks.image,
        speechModel: picks.speech,
        speechVoice: voice.trim(),
        videoModel: picks.video,
        transcriptionModel: picks.transcription,
        defaultAccess,
        enabled: editing?.enabled ?? true,
      };
      const result = editing
        ? await updateMediaMcpServerAction({ id: editing.id, ...input })
        : await createMediaMcpServerAction(input);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("form.saved", { mode }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("media.title", { mode, name: editing?.name ?? "" })}
      description={t("media.description")}
      submitLabel={t("form.submit", { mode })}
      pending={pending}
      isSubmitDisabled={!name.trim() || !KINDS.some((kind) => picks[kind])}
      onSubmit={save}
    >
      {models.length === 0 ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Description>{t("media.noModels")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
        <Label>{t("form.name")}</Label>
        <Input />
        <Description>{t("form.nameHint")}</Description>
      </TextField>
      <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending}>
        <Label>{t("form.descriptionField")}</Label>
        <Input />
      </TextField>
      {KINDS.map((kind) => (
        <SearchSelect
          key={kind}
          label={t("media.model", { kind })}
          description={t("media.modelHint", { kind })}
          placeholder={t("media.none")}
          items={itemsFor(kind)}
          value={picks[kind] || NONE}
          onChange={(id) => setPicks((current) => ({ ...current, [kind]: id === NONE ? "" : id }))}
          isDisabled={pending}
        />
      ))}
      {picks.speech ? (
        <TextField fullWidth value={voice} onChange={setVoice} isDisabled={pending}>
          <Label>{t("media.voice")}</Label>
          <Input placeholder="alloy" />
          <Description>{t("media.voiceHint")}</Description>
        </TextField>
      ) : null}
      <div className="space-y-2">
        <DefaultAccessSelect value={defaultAccess} onChange={setDefaultAccess} isDisabled={pending} />
        <p className="text-sm text-muted" aria-live="polite">
          {t("media.everyone", {
            count: everyone.length,
            tools: format.list(everyone, { type: "conjunction" }),
          })}
        </p>
      </div>
    </FormDialog>
  );
}
