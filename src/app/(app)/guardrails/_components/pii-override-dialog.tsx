"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { isActionFail } from "@/lib/http/action-result";
import type { PiiOverrideView, PiiPolicy, PiiScope, PiiTarget } from "@/types/guardrails";
import { savePiiOverrideAction } from "../_action";
import PiiEntityPicker from "./pii-entity-picker";
import PiiPolicyFields from "./pii-policy-fields";

const SCOPES: PiiScope[] = ["org", "key"];

export default function PiiOverrideDialog({
  state,
  editing,
  targets,
  inherited,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: PiiOverrideView | null;
  targets: PiiTarget[];
  inherited: (target: PiiTarget) => PiiPolicy;
  onSaved: (result: { scope: PiiScope; id: string; override: PiiOverrideView | null }) => void;
}) {
  const t = useTranslations("Guardrails");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [scope, setScope] = useState<PiiScope>(
    () => editing?.scope ?? SCOPES.find((s) => targets.some((row) => row.scope === s)) ?? "org",
  );
  const [targetId, setTargetId] = useState(
    () => editing?.id ?? targets.find((row) => row.scope === scope)?.id ?? "",
  );
  const [policy, setPolicy] = useState<PiiPolicy>(() => {
    if (editing) return editing.policy;
    const first = targets.find((row) => row.id === targetId);
    return first ? inherited(first) : { enabled: true, mode: "mask", output: true, entities: [] };
  });
  const [pending, start] = useTransition();
  const options = targets.filter((row) => row.scope === scope);
  const companies = new Map(targets.filter((row) => row.scope === "org").map((row) => [row.id, row.alias]));

  function pickTarget(id: string) {
    setTargetId(id);
    const target = targets.find((row) => row.id === id);
    if (target) setPolicy(inherited(target));
  }

  function save(close: () => void) {
    start(async () => {
      const result = await savePiiOverrideAction({ scope, id: targetId, policy });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result);
      toast(t("overrideSaved", { mode: "saved" }), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("overrideTitle", { mode: editing ? "edit" : "create" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <p className="text-sm text-muted">{t("overrideHint")}</p>
                  {editing ? (
                    <p className="text-sm">
                      {t("overrideTarget", { scope: editing.scope, alias: editing.alias })}
                    </p>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Select
                        selectedKey={scope}
                        onSelectionChange={(key) => {
                          const next = SCOPES.find((s) => s === key);
                          if (!next) return;
                          setScope(next);
                          pickTarget(targets.find((row) => row.scope === next)?.id ?? "");
                        }}
                        aria-label={t("scope")}
                        isDisabled={pending}
                        fullWidth
                      >
                        <Label>{t("scope")}</Label>
                        <Select.Trigger>
                          <Select.Value />
                          <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                          <ListBox aria-label={t("scope")}>
                            {SCOPES.map((s) => (
                              <ListBox.Item key={s} id={s} textValue={t("scopeLabel", { scope: s })}>
                                {t("scopeLabel", { scope: s })}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                      <SearchSelect
                        label={t("scopeLabel", { scope })}
                        placeholder={tCommon("none")}
                        items={options.map((row) => ({
                          id: row.id,
                          label: row.alias,
                          detail: row.scope === "key" ? companies.get(row.orgId) : undefined,
                        }))}
                        value={targetId}
                        onChange={pickTarget}
                        isDisabled={pending || options.length === 0}
                      />
                    </div>
                  )}
                  <PiiPolicyFields value={policy} onChange={setPolicy} isDisabled={pending} />
                  <PiiEntityPicker
                    value={policy.entities}
                    onChange={(entities) => setPolicy((cur) => ({ ...cur, entities }))}
                    isDisabled={pending}
                  />
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button isPending={pending} isDisabled={!targetId} onPress={() => save(close)}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("saveOverride")}
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
