"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Label, ListBox, Select, Spinner, Table, toast } from "@heroui/react";
import { UserMinus, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import type { BudgetTarget, MemberNode, StructurePayload } from "@/types/structure";
import { placeMemberAction } from "../_action";

export default function MembersCard({
  data,
  kind,
  id,
  onChanged,
  onBudget,
}: {
  data: StructurePayload;
  kind: "org" | "team";
  id: string;
  onChanged: (payload: StructurePayload) => void;
  onBudget: (target: BudgetTarget) => void;
}) {
  const t = useTranslations("Structure.members");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const team = kind === "team" ? data.teams.find((row) => row.id === id) : undefined;
  const orgId = kind === "org" ? id : (team?.orgId ?? "");
  const members = data.users.filter((user) => (kind === "org" ? user.orgId : user.teamId) === id);
  const memberIds = new Set(members.map((user) => user.id));
  const candidates = data.users.filter((user) => !memberIds.has(user.id));
  const teamAlias = (teamId: string) => data.teams.find((row) => row.id === teamId)?.alias ?? "";

  function place(user: MemberNode, next: { orgId: string; teamId: string }, done: string) {
    setBusy(user.id);
    start(async () => {
      const result = await placeMemberAction({ userId: user.id, ...next });
      setBusy(null);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onChanged(result);
      setUserId("");
      toast(done, { variant: "success" });
    });
  }

  function add() {
    const user = data.users.find((row) => row.id === userId);
    if (!user) return;
    const keepTeam = data.teams.find((row) => row.id === user.teamId)?.orgId === orgId;
    place(
      user,
      kind === "team"
        ? { orgId, teamId: id }
        : { orgId: id, teamId: keepTeam ? user.teamId : "" },
      t("added"),
    );
  }

  function remove(user: MemberNode) {
    place(
      user,
      kind === "team" ? { orgId: user.orgId, teamId: "" } : { orgId: "", teamId: "" },
      t("removed"),
    );
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t("title", { count: members.length })}</Card.Title>
        <Card.Description>{t("hint", { kind })}</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-4">
        {members.length === 0 ? (
          <p className="text-sm text-muted">{t("empty", { kind })}</p>
        ) : (
          <Table aria-label={t("title", { count: members.length })}>
            <Table.ScrollContainer>
              <Table.Content className="min-w-xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.user")}</Table.Column>
                  {kind === "org" ? <Table.Column>{t("columns.team")}</Table.Column> : null}
                  <Table.Column>{t("columns.budget")}</Table.Column>
                  <Table.Column>{tCommon("actions")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {members.map((user) => (
                    <Table.Row key={user.id} id={user.id}>
                      <Table.Cell>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {user.username}
                            {user.blocked ? (
                              <Chip size="sm" variant="soft" color="danger">
                                {tCommon("blockedState", { blocked: "true" })}
                              </Chip>
                            ) : null}
                          </p>
                          <p className="text-xs break-all text-muted">{user.email}</p>
                        </div>
                      </Table.Cell>
                      {kind === "org" ? (
                        <Table.Cell>{teamAlias(user.teamId) || t("noTeam")}</Table.Cell>
                      ) : null}
                      <Table.Cell>
                        {tCommon("spendBudget", {
                          hasCap: user.budget.maxBudget > 0 ? "yes" : "no",
                          spend: user.budget.spend,
                          budget: user.budget.maxBudget + user.budget.boost,
                        })}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex gap-1">
                          {data.canBudget ? (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("budget", { username: user.username })}
                              onPress={() =>
                                onBudget({ kind: "user", id: user.id, alias: user.username })
                              }
                            >
                              <Wallet size={14} aria-hidden />
                            </Button>
                          ) : null}
                          {data.canManage ? (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="danger-soft"
                              aria-label={t("remove", { username: user.username })}
                              isPending={busy === user.id}
                              isDisabled={pending && busy !== user.id}
                              onPress={() => remove(user)}
                            >
                              {({ isPending }) =>
                                isPending ? (
                                  <Spinner color="current" size="sm" />
                                ) : (
                                  <UserMinus size={14} aria-hidden />
                                )
                              }
                            </Button>
                          ) : null}
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}

        {data.canManage ? (
          candidates.length === 0 ? (
            <p className="text-sm text-muted">{t("noCandidates")}</p>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Select
                selectedKey={userId || null}
                onSelectionChange={(key) => setUserId(key == null ? "" : String(key))}
                placeholder={t("pick")}
                isDisabled={pending}
                className="sm:flex-1"
                fullWidth
              >
                <Label>{t("addLabel", { kind })}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox aria-label={t("addLabel", { kind })}>
                    {candidates.map((user) => (
                      <ListBox.Item
                        key={user.id}
                        id={user.id}
                        textValue={`${user.username} ${user.email}`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm">{user.username}</p>
                          <p className="text-xs text-muted">
                            {t("currentPlace", {
                              placed: user.teamId ? "team" : user.orgId ? "org" : "none",
                              team: teamAlias(user.teamId),
                              org: data.orgs.find((row) => row.id === user.orgId)?.alias ?? "",
                            })}
                          </p>
                        </div>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <Button
                isPending={pending && busy === userId}
                isDisabled={!userId || pending}
                onPress={add}
              >
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : null}
                    {t("add")}
                  </>
                )}
              </Button>
            </div>
          )
        ) : null}
      </Card.Content>
    </Card>
  );
}
