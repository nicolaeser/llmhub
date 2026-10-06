"use client";

import { useState, useTransition } from "react";
import {
  Button,
  ListBox,
  Modal,
  SearchField,
  Spinner,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { importProviderModelsAction } from "@/app/(app)/providers/_action";
import type { ProviderView } from "@/types/providers";

export default function ImportModelsDialog({
  state,
  provider,
  models,
  onImported,
}: {
  state: ReturnType<typeof useOverlayState>;
  provider: ProviderView | null;
  models: ProviderView["discovered"] | null;
  onImported: (provider: ProviderView) => void;
}) {
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const q = query.toLowerCase();
  const filtered = (models ?? []).filter(
    (m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
  );

  function save(close: () => void) {
    if (!provider) return;
    start(async () => {
      const result = await importProviderModelsAction({ id: provider.id, models: [...picked] });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onImported(result.provider);
      toast(tCommon("done"), { variant: "success" });
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
                  <Modal.Heading>{tCommon("import")}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <SearchField value={query} onChange={setQuery} aria-label={tCommon("search")}>
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder={tCommon("search")} />
                      <SearchField.ClearButton aria-label={tCommon("close")} />
                    </SearchField.Group>
                  </SearchField>
                  {models === null ? (
                    <output
                      aria-live="polite"
                      aria-label={tCommon("loading")}
                      className="flex justify-center py-6 text-accent"
                    >
                      <Spinner color="current" />
                    </output>
                  ) : models.length === 0 ? (
                    <p className="text-sm text-muted">{tCommon("empty")}</p>
                  ) : (
                    <ListBox
                      aria-label={tCommon("import")}
                      selectionMode="multiple"
                      selectedKeys={picked}
                      onSelectionChange={(keys) =>
                        setPicked(
                          keys === "all"
                            ? new Set(filtered.map((m) => m.id))
                            : new Set([...keys].map(String)),
                        )
                      }
                      className="max-h-72 overflow-y-auto"
                    >
                      {filtered.map((m) => (
                        <ListBox.Item key={m.id} id={m.id} textValue={m.id}>
                          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span className="truncate font-mono text-xs">{m.id}</span>
                            <span className="truncate text-xs text-muted">{m.name}</span>
                          </div>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  )}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending} aria-label={tCommon("cancel")}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    aria-label={tCommon("import")}
                    isPending={pending}
                    isDisabled={!provider || models === null}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {tCommon("import")}
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
