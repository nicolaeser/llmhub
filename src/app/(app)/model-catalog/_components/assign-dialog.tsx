"use client";

import { useState, useTransition } from "react";
import {
  Button,
  ComboBox,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Spinner,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { assignCatalogEntryAction } from "@/app/(app)/model-catalog/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { CatalogEntryView, CatalogView } from "@/types/model-catalog";

export default function AssignDialog({
  state,
  entry,
  current,
  aliases,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  entry: CatalogEntryView | null;
  current: string;
  aliases: string[];
  onSaved: (view: CatalogView) => void;
}) {
  const t = useTranslations("ModelCatalog");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [alias, setAlias] = useState(current);
  const [pending, start] = useTransition();
  const target = alias.trim().toLowerCase();

  function save(close: () => void) {
    if (!entry) return;
    start(async () => {
      const result = await assignCatalogEntryAction({
        providerId: entry.providerId,
        upstreamId: entry.upstreamId,
        alias: target,
      });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result);
      toast(t("saved"), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("assignTitle", { model: entry?.upstreamId ?? "" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <ComboBox
                    fullWidth
                    allowsCustomValue
                    inputValue={alias}
                    onInputChange={setAlias}
                    onSelectionChange={(key) => {
                      if (key !== null) setAlias(String(key));
                    }}
                    isDisabled={pending}
                  >
                    <Label>{t("assignAlias")}</Label>
                    <ComboBox.InputGroup>
                      <Input />
                      <ComboBox.Trigger />
                    </ComboBox.InputGroup>
                    <Description>{t("assignHint")}</Description>
                    <ComboBox.Popover>
                      <ListBox aria-label={t("assignAlias")}>
                        {aliases.map((option) => (
                          <ListBox.Item key={option} id={option} textValue={option}>
                            <span className="font-mono text-sm">{option}</span>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </ComboBox.Popover>
                  </ComboBox>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!entry || !target || target === current}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("assignSubmit")}
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
