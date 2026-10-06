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
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import type { NodeKind, NodeRef, StructurePayload } from "@/types/structure";
import { saveMemberAction, saveOrgAction, saveProjectAction, saveTeamAction } from "../_action";

function idsOf(data: StructurePayload, kind: NodeKind): Set<string> {
  const rows =
    kind === "org" ? data.orgs : kind === "team" ? data.teams : kind === "project" ? data.projects : data.members;
  return new Set(rows.map((row) => row.id));
}

export default function NodeDialog({
  state,
  kind,
  editingId,
  orgId: initialOrg,
  teamId: initialTeam,
  data,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  kind: NodeKind;
  editingId: string | null;
  orgId: string;
  teamId: string;
  data: StructurePayload;
  onSaved: (payload: StructurePayload, ref: NodeRef | null) => void;
}) {
  const t = useTranslations("Companies.node");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const org = kind === "org" ? data.orgs.find((row) => row.id === editingId) : undefined;
  const team = kind === "team" ? data.teams.find((row) => row.id === editingId) : undefined;
  const project = kind === "project" ? data.projects.find((row) => row.id === editingId) : undefined;
  const member = kind === "member" ? data.members.find((row) => row.id === editingId) : undefined;
  const editing = Boolean(org ?? team ?? project ?? member);
  const placed = team ?? project ?? member;
  const [alias, setAlias] = useState(org?.alias ?? placed?.alias ?? "");
  const [orgId, setOrgId] = useState(placed?.orgId ?? (initialOrg || data.orgs[0]?.id || ""));
  const [teamId, setTeamId] = useState(project?.teamId ?? member?.teamId ?? initialTeam);
  const [rpm, setRpm] = useState(team?.rpmLimit ?? 0);
  const [tpm, setTpm] = useState(team?.tpmLimit ?? 0);
  const [owner, setOwner] = useState(project?.owner ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [blocked, setBlocked] = useState(member?.blocked ?? false);
  const [logContent, setLogContent] = useState(member?.logContent ?? true);
  const [pending, start] = useTransition();
  const mode = editing ? "edit" : "create";
  const needsOrg = kind !== "org";
  const hasDepartment = kind === "project" || kind === "member";
  const departments = data.teams.filter((row) => row.orgId === orgId);

  function save(close: () => void) {
    start(async () => {
      const id = editingId ?? undefined;
      const before = idsOf(data, kind);
      const result =
        kind === "org"
          ? await saveOrgAction({ id, alias })
          : kind === "team"
            ? await saveTeamAction({
                id,
                alias,
                orgId,
                rpm: Number.isFinite(rpm) ? rpm : 0,
                tpm: Number.isFinite(tpm) ? tpm : 0,
              })
            : kind === "project"
              ? await saveProjectAction({ id, alias, orgId, teamId, owner })
              : await saveMemberAction({ id, alias, email, orgId, teamId, blocked, logContent });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      const created = [...idsOf(result, kind)].find((row) => !before.has(row));
      const ref = editingId ? { kind, id: editingId } : created ? { kind, id: created } : null;
      onSaved(result, ref);
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
                  {needsOrg ? (
                    <Select
                      isRequired
                      selectedKey={orgId || null}
                      onSelectionChange={(key) => {
                        setOrgId(key == null ? "" : String(key));
                        setTeamId("");
                      }}
                      isDisabled={pending || editing || data.orgs.length < 2}
                      placeholder={t("orgPlaceholder")}
                      fullWidth
                    >
                      <Label>{t("org")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={t("org")}>
                          {data.orgs.map((item) => (
                            <ListBox.Item key={item.id} id={item.id} textValue={item.alias}>
                              {item.alias}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                      {editing ? <Description>{t("orgLocked", { kind })}</Description> : null}
                    </Select>
                  ) : null}

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

                  {hasDepartment ? (
                    <Select
                      selectedKey={teamId || "none"}
                      onSelectionChange={(key) => setTeamId(key == null || key === "none" ? "" : String(key))}
                      isDisabled={pending || !orgId}
                      fullWidth
                    >
                      <Label>{t("team")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={t("team")}>
                          <ListBox.Item id="none" textValue={t("noTeam")}>
                            {t("noTeam")}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                          {departments.map((item) => (
                            <ListBox.Item key={item.id} id={item.id} textValue={item.alias}>
                              {item.alias}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                      <Description>{t("teamHint", { kind })}</Description>
                    </Select>
                  ) : null}

                  {kind === "member" ? (
                    <TextField
                      fullWidth
                      type="email"
                      value={email}
                      onChange={setEmail}
                      isDisabled={pending}
                      maxLength={254}
                    >
                      <Label>{t("email")}</Label>
                      <Input placeholder="alex@example.com" />
                      <Description>{t("emailHint")}</Description>
                    </TextField>
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
                    <TextField fullWidth value={owner} onChange={setOwner} isDisabled={pending} maxLength={200}>
                      <Label>{t("owner")}</Label>
                      <Input placeholder="ops@example.com" />
                      <Description>{t("ownerHint")}</Description>
                    </TextField>
                  ) : null}

                  {kind === "member" ? (
                    <>
                      <Switch isSelected={logContent} onChange={setLogContent} isDisabled={pending}>
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                          <Label>{t("logContent")}</Label>
                        </Switch.Content>
                        <Description>{t("logContentHint")}</Description>
                      </Switch>
                      {editing ? (
                        <Switch isSelected={blocked} onChange={setBlocked} isDisabled={pending}>
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <Label>{t("blocked")}</Label>
                          </Switch.Content>
                          <Description>{t("blockedHint")}</Description>
                        </Switch>
                      ) : null}
                    </>
                  ) : null}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!alias.trim() || (needsOrg && !orgId)}
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
