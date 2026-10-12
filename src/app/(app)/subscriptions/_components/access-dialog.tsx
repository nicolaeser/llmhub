"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Modal, Spinner, ToggleButton, ToggleButtonGroup, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import { loadAssignmentOptionsAction, saveAssignmentsAction } from "@/app/(app)/subscriptions/_action";
import MultiPicker from "@/components/console/multi-picker";
import { ASSIGNMENT_SCOPES } from "@/lib/gateway/account-access";
import { isActionFail } from "@/lib/http/action-result";
import type { AssignmentOptions, AssignmentScope, ProviderView } from "@/types/providers";

type Mode = "open" | "limited";

const MODES: Mode[] = ["open", "limited"];

function pickedFrom(provider: ProviderView | null): Record<AssignmentScope, string[]> {
  const picked: Record<AssignmentScope, string[]> = { org: [], team: [], project: [], member: [], key: [] };
  for (const target of provider?.assignments ?? []) picked[target.scope].push(target.id);
  return picked;
}

export default function AccessDialog({
  state,
  provider,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  provider: ProviderView | null;
  onSaved: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Subscriptions.access");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [mode, setMode] = useState<Mode>(provider?.restricted ? "limited" : "open");
  const [picked, setPicked] = useState(() => pickedFrom(provider));
  const [options, setOptions] = useState<AssignmentOptions | null>(null);
  const [pending, start] = useTransition();
  const modeLabel = t("mode");
  const isOpen = state.isOpen;

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    loadAssignmentOptionsAction().then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        setOptions({ org: [], team: [], project: [], member: [], key: [] });
        return;
      }
      setOptions(result.options);
    });
    return () => {
      active = false;
    };
  }, [isOpen, tError]);

  const total = ASSIGNMENT_SCOPES.reduce((sum, scope) => sum + picked[scope].length, 0);

  function itemsFor(scope: AssignmentScope) {
    const known = options?.[scope] ?? [];
    const labels = (provider?.assignments ?? [])
      .filter((target) => target.scope === scope && !known.some((item) => item.id === target.id))
      .map((target) => ({ id: target.id, label: target.label }));
    return [...known, ...labels];
  }

  function save(close: () => void) {
    if (!provider) return;
    start(async () => {
      const result = await saveAssignmentsAction({
        providerId: provider.id,
        restricted: mode === "limited",
        targets: ASSIGNMENT_SCOPES.flatMap((scope) => picked[scope].map((id) => ({ scope, id }))),
      });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved({ ...provider, restricted: result.restricted, assignments: result.assignments });
      toast(t("saved", { name: provider.name }), { variant: "success" });
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
                  <Modal.Heading>{t("title", { name: provider?.name ?? "" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <p className="text-sm text-muted">{t("description")}</p>
                  <ToggleButtonGroup
                    fullWidth
                    selectionMode="single"
                    disallowEmptySelection
                    aria-label={modeLabel}
                    selectedKeys={[mode]}
                    onSelectionChange={(keys) => {
                      const next = MODES.find((item) => item === [...keys][0]);
                      if (next) setMode(next);
                    }}
                    isDisabled={pending}
                  >
                    {MODES.map((item, index) => (
                      <ToggleButton key={item} id={item}>
                        {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                        {t("modes", { mode: item })}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  {mode === "limited" ? (
                    options === null ? (
                      <output
                        aria-live="polite"
                        aria-label={tCommon("loading")}
                        className="flex justify-center py-6 text-accent"
                      >
                        <Spinner color="current" />
                      </output>
                    ) : (
                      <div className="space-y-4">
                        {ASSIGNMENT_SCOPES.map((scope) => (
                          <MultiPicker
                            key={scope}
                            label={t("scope", { scope })}
                            placeholder={t("scope", { scope })}
                            searchLabel={t("search")}
                            emptyLabel={t("empty")}
                            items={itemsFor(scope)}
                            selected={picked[scope]}
                            onChange={(ids) => setPicked((cur) => ({ ...cur, [scope]: ids }))}
                            isDisabled={pending}
                          />
                        ))}
                        {total === 0 ? <p className="text-sm text-warning">{t("nothing")}</p> : null}
                      </div>
                    )
                  ) : null}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending} aria-label={tCommon("cancel")}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    aria-label={t("save")}
                    isPending={pending}
                    isDisabled={!provider || (mode === "limited" && options === null)}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("save")}
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
