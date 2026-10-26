"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  FieldError,
  Form,
  Input,
  Label,
  Spinner,
  Tag,
  TagGroup,
  TextField,
} from "@heroui/react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  labelKey,
  MAX_LABEL_KEY_LENGTH,
  MAX_LABEL_KEYS,
  MAX_LABEL_VALUE_LENGTH,
  MAX_REQUEST_LABELS,
} from "@/lib/usage/labels";

export default function LabelKeysEditor({
  keys,
  inherited = [],
  canManage,
  onSave,
}: {
  keys: string[];
  inherited?: string[];
  canManage: boolean;
  onSave: (keys: string[]) => Promise<boolean>;
}) {
  const t = useTranslations("Usage.labels");
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const next = labelKey(draft);
  const typed = draft.trim() !== "";
  const problem = !typed ? null : !next ? "invalid" : keys.includes(next) || inherited.includes(next) ? "listed" : null;
  const full = keys.length >= MAX_LABEL_KEYS;

  function save(list: string[], clear: boolean) {
    start(async () => {
      if ((await onSave(list)) && clear) setDraft("");
    });
  }

  return (
    <div className="space-y-4">
      {keys.length ? (
        <TagGroup
          aria-label={t("listed")}
          onRemove={canManage && !pending ? (removed) => save(keys.filter((key) => !removed.has(key)), false) : undefined}
        >
          <TagGroup.List>
            {keys.map((key) => (
              <Tag key={key} id={key} textValue={key}>
                <span className="font-mono">{key}</span>
                {canManage ? <Tag.RemoveButton aria-label={t("remove", { key })} /> : null}
              </Tag>
            ))}
          </TagGroup.List>
        </TagGroup>
      ) : (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}
      {inherited.length ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">{t("inherited")}</p>
          <TagGroup aria-label={t("inherited")}>
            <TagGroup.List>
              {inherited.map((key) => (
                <Tag key={key} id={key} textValue={key}>
                  <span className="font-mono">{key}</span>
                </Tag>
              ))}
            </TagGroup.List>
          </TagGroup>
        </div>
      ) : null}
      {canManage ? (
        <Form
          className="flex flex-col gap-3 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            if (next && !problem && !full) save([...keys, next], true);
          }}
        >
          <TextField
            fullWidth
            value={draft}
            onChange={setDraft}
            isInvalid={problem !== null}
            isDisabled={pending || full}
            maxLength={MAX_LABEL_KEY_LENGTH}
            className="sm:max-w-xs"
          >
            <Label>{t("add")}</Label>
            <Input placeholder="cost_center" className="font-mono" />
            <Description>
              {full ? t("full", { max: MAX_LABEL_KEYS }) : t("keyRule", { max: MAX_LABEL_KEY_LENGTH })}
            </Description>
            <FieldError>{t("problem", { problem: problem ?? "invalid" })}</FieldError>
          </TextField>
          <Button
            type="submit"
            variant="secondary"
            className="sm:mt-6"
            isPending={pending}
            isDisabled={!next || problem !== null || full}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <Plus size={14} aria-hidden />}
                {t("addButton")}
              </>
            )}
          </Button>
        </Form>
      ) : null}
      <p className="text-xs text-muted">
        {t.rich("howTo", { code: (chunks) => <code className="font-mono break-words">{chunks}</code> })}
      </p>
      <p className="text-xs text-muted">
        {t("limits", {
          labels: MAX_REQUEST_LABELS,
          keyLength: MAX_LABEL_KEY_LENGTH,
          valueLength: MAX_LABEL_VALUE_LENGTH,
        })}
      </p>
    </div>
  );
}
