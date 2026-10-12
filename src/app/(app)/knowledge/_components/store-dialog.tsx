"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  NumberField,
  Separator,
  Spinner,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { createKnowledgeAction, updateKnowledgeAction } from "@/app/(app)/knowledge/_action";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import { MAX_CHUNK_TOKENS, MIN_CHUNK_TOKENS } from "@/schemas/rag";
import type { KnowledgeCompany, KnowledgeProject, VectorStoreDefaults, VectorStoreView } from "@/types/rag";

const DEFAULT_KEY = ":default";
const WHOLE_COMPANY_KEY = ":company";
const DEFAULT_CHUNK_TOKENS = 800;
const DEFAULT_OVERLAP_TOKENS = 400;
const MAX_DIMENSIONS = 8192;
const MAX_EXPIRY_DAYS = 365;

function isWhole(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export default function StoreDialog({
  state,
  editing,
  companies,
  projects,
  defaults,
  aliases,
  initialCompany,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: VectorStoreView | null;
  companies: KnowledgeCompany[];
  projects: KnowledgeProject[];
  defaults: VectorStoreDefaults;
  aliases: string[];
  initialCompany: string;
  onSaved: (store: VectorStoreView) => void;
}) {
  const t = useTranslations("Knowledge");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [orgId, setOrgId] = useState(
    () => initialCompany || (companies.length === 1 ? companies[0].id : ""),
  );
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [dimensions, setDimensions] = useState(0);
  const [rerankModel, setRerankModel] = useState(editing?.rerankModel ?? "");
  const [ocrModel, setOcrModel] = useState(editing?.ocrModel ?? "");
  const [chunk, setChunk] = useState(DEFAULT_CHUNK_TOKENS);
  const [overlap, setOverlap] = useState(DEFAULT_OVERLAP_TOKENS);
  const [expiry, setExpiry] = useState(editing?.expiresAfterDays ?? Number.NaN);
  const [pending, start] = useTransition();

  const mode = editing ? "edit" : "create";
  const maxOverlap = Math.floor((Number.isFinite(chunk) ? chunk : DEFAULT_CHUNK_TOKENS) / 2);
  const nameValid = name.trim().length > 0;
  const embeddingValid = Boolean(editing || embeddingModel || defaults.embedding_model);
  const chunkValid = isWhole(chunk, MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS);
  const overlapValid = isWhole(overlap, 0, maxOverlap);
  const valid = nameValid && (editing !== null || (Boolean(orgId) && embeddingValid && chunkValid && overlapValid));
  const companyProjects = projects.filter((project) => project.orgId === orgId);

  function modelItems(current: string, fallback: string) {
    return [
      {
        id: DEFAULT_KEY,
        label: t("dialog.modelDefault", { hasDefault: fallback ? "true" : "false", alias: fallback }),
      },
      ...[...new Set([...aliases, ...(current ? [current] : [])])].map((alias) => ({ id: alias, label: alias })),
    ];
  }

  const pickModel = (key: string) => (key === DEFAULT_KEY ? "" : key);
  const expiresAfterDays = Number.isNaN(expiry) ? null : expiry;

  function save(close: () => void) {
    start(async () => {
      const result = editing
        ? await updateKnowledgeAction({
            id: editing.id,
            name,
            description,
            rerankModel,
            ocrModel,
            expiresAfterDays,
          })
        : await createKnowledgeAction({
            orgId,
            projectId: projectId || null,
            name,
            description,
            embeddingModel,
            embeddingDimensions: Number.isNaN(dimensions) ? 0 : dimensions,
            rerankModel,
            ocrModel,
            chunkMaxTokens: chunk,
            chunkOverlapTokens: overlap,
            expiresAfterDays,
          });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.store);
      toast(t("toasts.saved", { mode }), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("dialog.title", { mode })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  {editing ? null : (
                    <>
                      <SearchSelect
                        isRequired
                        label={t("dialog.company")}
                        placeholder={t("dialog.companyPlaceholder")}
                        items={companies.map((company) => ({ id: company.id, label: company.alias }))}
                        value={orgId}
                        onChange={(next) => {
                          setOrgId(next);
                          setProjectId("");
                        }}
                        isDisabled={pending || companies.length < 2}
                      />
                      <SearchSelect
                        label={t("dialog.project")}
                        items={[
                          { id: WHOLE_COMPANY_KEY, label: t("dialog.wholeCompany") },
                          ...companyProjects.map((project) => ({ id: project.id, label: project.alias })),
                        ]}
                        value={projectId || WHOLE_COMPANY_KEY}
                        onChange={(next) => setProjectId(next === WHOLE_COMPANY_KEY ? "" : next)}
                        isDisabled={pending || !orgId}
                        description={t("dialog.projectHint", { scope: projectId ? "project" : "organization" })}
                      />
                      <Separator />
                    </>
                  )}
                  <TextField
                    fullWidth
                    isRequired
                    value={name}
                    onChange={setName}
                    maxLength={256}
                    isDisabled={pending}
                    isInvalid={name.length > 0 && !nameValid}
                  >
                    <Label>{t("dialog.name")}</Label>
                    <Input />
                    <FieldError>{t("dialog.nameRequired")}</FieldError>
                  </TextField>
                  <TextField fullWidth value={description} onChange={setDescription} maxLength={512} isDisabled={pending}>
                    <Label>{t("dialog.description")}</Label>
                    <Input />
                  </TextField>
                  <Separator />
                  {editing ? (
                    <p className="text-sm text-muted">
                      {t("dialog.fixed", {
                        model: editing.embeddingModel,
                        dimensions: editing.embeddingDimensions,
                        chunk: editing.chunkMaxTokens,
                        overlap: editing.chunkOverlapTokens,
                      })}
                    </p>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <SearchSelect
                          isRequired={!defaults.embedding_model}
                          label={t("dialog.embeddingModel")}
                          placeholder={t("dialog.embeddingPlaceholder")}
                          items={
                            defaults.embedding_model
                              ? modelItems(embeddingModel, defaults.embedding_model)
                              : aliases.map((alias) => ({ id: alias, label: alias }))
                          }
                          value={embeddingModel || (defaults.embedding_model ? DEFAULT_KEY : "")}
                          onChange={(key) => setEmbeddingModel(pickModel(key))}
                          isDisabled={pending}
                          description={t("dialog.embeddingHint", {
                            hasDefault: defaults.embedding_model ? "true" : "false",
                          })}
                        />
                      </div>
                      <NumberField
                        fullWidth
                        value={dimensions}
                        onChange={setDimensions}
                        minValue={0}
                        maxValue={MAX_DIMENSIONS}
                        formatOptions={formats.number.integer}
                        isDisabled={pending}
                        className="sm:col-span-2"
                      >
                        <Label>{t("dialog.dimensions")}</Label>
                        <NumberField.Group>
                          <NumberField.DecrementButton />
                          <NumberField.Input />
                          <NumberField.IncrementButton />
                        </NumberField.Group>
                        <Description>{t("dialog.dimensionsHint")}</Description>
                      </NumberField>
                      <NumberField
                        fullWidth
                        isRequired
                        value={chunk}
                        onChange={setChunk}
                        minValue={MIN_CHUNK_TOKENS}
                        maxValue={MAX_CHUNK_TOKENS}
                        step={50}
                        formatOptions={formats.number.integer}
                        isDisabled={pending}
                        isInvalid={!chunkValid}
                      >
                        <Label>{t("dialog.chunkSize")}</Label>
                        <NumberField.Group>
                          <NumberField.DecrementButton />
                          <NumberField.Input />
                          <NumberField.IncrementButton />
                        </NumberField.Group>
                        {chunkValid ? (
                          <Description>{t("dialog.chunkSizeHint")}</Description>
                        ) : (
                          <FieldError>{t("dialog.chunkSizeHint")}</FieldError>
                        )}
                      </NumberField>
                      <NumberField
                        fullWidth
                        isRequired
                        value={overlap}
                        onChange={setOverlap}
                        minValue={0}
                        maxValue={maxOverlap}
                        step={50}
                        formatOptions={formats.number.integer}
                        isDisabled={pending}
                        isInvalid={!overlapValid}
                      >
                        <Label>{t("dialog.chunkOverlap")}</Label>
                        <NumberField.Group>
                          <NumberField.DecrementButton />
                          <NumberField.Input />
                          <NumberField.IncrementButton />
                        </NumberField.Group>
                        {overlapValid ? (
                          <Description>{t("dialog.chunkOverlapHint", { max: maxOverlap })}</Description>
                        ) : (
                          <FieldError>{t("dialog.chunkOverlapInvalid", { max: maxOverlap })}</FieldError>
                        )}
                      </NumberField>
                    </div>
                  )}
                  <SearchSelect
                    label={t("dialog.rerankModel")}
                    items={modelItems(rerankModel, defaults.rerank_model)}
                    value={rerankModel || DEFAULT_KEY}
                    onChange={(key) => setRerankModel(pickModel(key))}
                    isDisabled={pending}
                    description={t("dialog.rerankHint")}
                  />
                  <SearchSelect
                    label={t("dialog.ocrModel")}
                    items={modelItems(ocrModel, defaults.ocr_model)}
                    value={ocrModel || DEFAULT_KEY}
                    onChange={(key) => setOcrModel(pickModel(key))}
                    isDisabled={pending}
                    description={t("dialog.ocrHint")}
                  />
                  <NumberField
                    fullWidth
                    value={expiry}
                    onChange={setExpiry}
                    minValue={1}
                    maxValue={MAX_EXPIRY_DAYS}
                    formatOptions={formats.number.integer}
                    isDisabled={pending}
                  >
                    <Label>{t("dialog.expiry")}</Label>
                    <NumberField.Group>
                      <NumberField.DecrementButton />
                      <NumberField.Input />
                      <NumberField.IncrementButton />
                    </NumberField.Group>
                    <Description>{t("dialog.expiryHint")}</Description>
                  </NumberField>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button isPending={pending} isDisabled={!valid} onPress={() => save(close)}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("dialog.submit", { mode })}
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
