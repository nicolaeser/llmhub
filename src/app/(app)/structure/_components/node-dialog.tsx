"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  Select,
  Spinner,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import type { NodeKind, NodeRef, StructurePayload } from "@/types/structure";
import { saveOrgAction, saveProjectAction, saveTeamAction } from "../_action";

function findNode(
  data: StructurePayload,
  kind: NodeKind,
  alias: string,
  parentId: string,
): NodeRef | null {
  const same = (value: string) => value.trim().toLowerCase() === alias.trim().toLowerCase();
  const row =
    kind === "org"
      ? data.orgs.find((item) => same(item.alias))
      : kind === "team"
        ? data.teams.find((item) => same(item.alias) && item.orgId === parentId)
        : data.projects.find((item) => same(item.alias) && item.teamId === parentId);
  return row ? { kind, id: row.id } : null;
}

export default function NodeDialog({
  state,
  kind,
  editingId,
  parentId: initialParent,
  data,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  kind: NodeKind;
  editingId: string | null;
  parentId: string;
  data: StructurePayload;
  onSaved: (payload: StructurePayload, ref: NodeRef | null) => void;
}) {
  const t = useTranslations("Structure.node");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const team = kind === "team" ? data.teams.find((row) => row.id === editingId) : undefined;
  const project =
    kind === "project" ? data.projects.find((row) => row.id === editingId) : undefined;
  const org = kind === "org" ? data.orgs.find((row) => row.id === editingId) : undefined;
  const editing = Boolean(team ?? project ?? org);
  const [alias, setAlias] = useState(team?.alias ?? project?.alias ?? org?.alias ?? "");
  const [parentId, setParentId] = useState(team?.orgId ?? project?.teamId ?? initialParent);
  const [rpm, setRpm] = useState(team?.rpmLimit ?? 0);
  const [tpm, setTpm] = useState(team?.tpmLimit ?? 0);
  const [owner, setOwner] = useState(project?.owner ?? "");
  const [pending, start] = useTransition();
  const mode = editing ? "edit" : "create";
  const ownerKey =
    data.users.find((user) => user.id === owner || user.email === owner)?.id ?? "none";
  const orgAlias = (id: string) => data.orgs.find((row) => row.id === id)?.alias ?? "";
  const needsParent = kind !== "org";
  const parents =
    kind === "team"
      ? data.orgs.map((row) => ({ id: row.id, label: row.alias }))
      : data.teams.map((row) => ({
          id: row.id,
          label: t("teamOption", { team: row.alias, org: orgAlias(row.orgId) || tCommon("none") }),
        }));

  function save(close: () => void) {
    start(async () => {
      const id = editingId ?? undefined;
      const result =
        kind === "org"
          ? await saveOrgAction({ id, alias })
          : kind === "team"
            ? await saveTeamAction({
                id,
                alias,
                orgId: parentId,
                rpm: Number.isFinite(rpm) ? rpm : 0,
                tpm: Number.isFinite(tpm) ? tpm : 0,
              })
            : await saveProjectAction({ id, alias, teamId: parentId, owner });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result, findNode(result, kind, alias, parentId));
      toast(t("saved", { kind, mode }), { variant: "success" });
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
                  <Modal.Heading>{t("title", { kind, mode })}</Modal.Heading>
                  <p className="text-sm text-muted">{t("hint", { kind })}</p>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <TextField
                    fullWidth
                    isRequired
                    value={alias}
                    onChange={setAlias}
                    isDisabled={pending}
                    maxLength={80}
                  >
                    <Label>{t("name", { kind })}</Label>
                    <Input placeholder={t("placeholder", { kind })} />
                  </TextField>

                  {needsParent ? (
                    <Select
                      isRequired
                      selectedKey={parentId || null}
                      onSelectionChange={(key) => setParentId(key == null ? "" : String(key))}
                      isDisabled={pending || parents.length === 0}
                      placeholder={t("parentPlaceholder", { kind })}
                      fullWidth
                    >
                      <Label>{t("parent", { kind })}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={t("parent", { kind })}>
                          {parents.map((item) => (
                            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                              {item.label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                      <Description>{t("parentHint", { kind, mode })}</Description>
                    </Select>
                  ) : null}

                  {kind === "team" ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <NumberField
                        fullWidth
                        value={rpm}
                        onChange={setRpm}
                        minValue={0}
                        formatOptions={formats.number.integer}
                        isDisabled={pending}
                      >
                        <Label>{t("rpm")}</Label>
                        <NumberField.Group>
                          <NumberField.DecrementButton />
                          <NumberField.Input />
                          <NumberField.IncrementButton />
                        </NumberField.Group>
                        <Description>{t("rpmHint")}</Description>
                      </NumberField>
                      <NumberField
                        fullWidth
                        value={tpm}
                        onChange={setTpm}
                        minValue={0}
                        formatOptions={formats.number.integer}
                        isDisabled={pending}
                      >
                        <Label>{t("tpm")}</Label>
                        <NumberField.Group>
                          <NumberField.DecrementButton />
                          <NumberField.Input />
                          <NumberField.IncrementButton />
                        </NumberField.Group>
                        <Description>{t("tpmHint")}</Description>
                      </NumberField>
                    </div>
                  ) : null}

                  {kind === "project" ? (
                    <Select
                      selectedKey={ownerKey}
                      onSelectionChange={(key) =>
                        setOwner(String(key) === "none" ? "" : String(key))
                      }
                      isDisabled={pending}
                      fullWidth
                    >
                      <Label>{t("owner")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={t("owner")}>
                          <ListBox.Item id="none" textValue={tCommon("none")}>
                            {tCommon("none")}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                          {data.users.map((user) => (
                            <ListBox.Item
                              key={user.id}
                              id={user.id}
                              textValue={`${user.username} ${user.email}`}
                            >
                              {user.username}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                      <Description>{t("ownerHint")}</Description>
                    </Select>
                  ) : null}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!alias.trim() || (needsParent && !parentId)}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("submit", { kind, mode })}
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
