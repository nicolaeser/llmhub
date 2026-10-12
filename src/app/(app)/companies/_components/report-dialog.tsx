"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  FieldError,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Switch,
  TextArea,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { routing } from "@/i18n/routing";
import { isActionFail } from "@/lib/http/action-result";
import { MAX_REPORT_RECIPIENTS, REPORT_CADENCES, REPORT_FORMATS } from "@/lib/reports/period";
import { reportRecipientSchema } from "@/schemas/reports";
import type { MemberNode } from "@/types/structure";
import type { ReportCadence, ReportFormat, UsageReportView } from "@/types/reports";
import { saveReportAction } from "../_action";

function splitRecipients(value: string): string[] {
  return value.split(/[\s,;]+/).filter(Boolean);
}

export default function ReportDialog({
  state,
  report,
  kind,
  name,
  orgId,
  teamId,
  people,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  report: UsageReportView | null;
  kind: "org" | "team";
  name: string;
  orgId: string;
  teamId: string;
  people: MemberNode[];
  onSaved: (reports: UsageReportView[]) => void;
}) {
  const t = useTranslations("Companies.reports.dialog");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const locale = useLocale();
  const [cadence, setCadence] = useState<ReportCadence>(report?.cadence ?? "monthly");
  const [attachment, setAttachment] = useState<ReportFormat>(report?.format ?? "pdf");
  const [language, setLanguage] = useState(report?.locale ?? locale);
  const [recipients, setRecipients] = useState(report?.recipients.join("\n") ?? "");
  const [enabled, setEnabled] = useState(report?.enabled ?? true);
  const [pending, start] = useTransition();
  const mode = report ? "edit" : "create";
  const list = splitRecipients(recipients);
  const invalid = list.filter((value) => !reportRecipientSchema.safeParse(value).success);
  const tooMany = new Set(list.map((value) => value.toLowerCase())).size > MAX_REPORT_RECIPIENTS;
  const listed = new Set(list.map((value) => value.toLowerCase()));
  const suggestions = people.filter((person) => person.email && !listed.has(person.email.toLowerCase()));

  function save(close: () => void) {
    start(async () => {
      const result = await saveReportAction({
        id: report?.id,
        orgId,
        teamId,
        cadence,
        format: attachment,
        locale: language,
        recipients: list,
        enabled,
      });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.reports);
      toast(t("saved", { mode }), { variant: "success" });
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
                  <Modal.Heading>{t("title", { mode })}</Modal.Heading>
                  <p className="text-sm text-muted">{t("hint", { kind, name })}</p>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Select
                      fullWidth
                      selectedKey={cadence}
                      onSelectionChange={(key) => {
                        const next = REPORT_CADENCES.find((value) => value === key);
                        if (next) setCadence(next);
                      }}
                      isDisabled={pending}
                    >
                      <Label>{t("cadence")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Description>{t("cadenceHint", { cadence })}</Description>
                      <Select.Popover>
                        <ListBox aria-label={t("cadence")}>
                          {REPORT_CADENCES.map((value) => (
                            <ListBox.Item key={value} id={value} textValue={t("cadenceOption", { cadence: value })}>
                              {t("cadenceOption", { cadence: value })}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <Select
                      fullWidth
                      selectedKey={attachment}
                      onSelectionChange={(key) => {
                        const next = REPORT_FORMATS.find((value) => value === key);
                        if (next) setAttachment(next);
                      }}
                      isDisabled={pending}
                    >
                      <Label>{t("format")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Description>{t("formatHint", { format: attachment })}</Description>
                      <Select.Popover>
                        <ListBox aria-label={t("format")}>
                          {REPORT_FORMATS.map((value) => (
                            <ListBox.Item key={value} id={value} textValue={t("formatOption", { format: value })}>
                              {t("formatOption", { format: value })}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </div>

                  <Select
                    fullWidth
                    selectedKey={language}
                    onSelectionChange={(key) => {
                      if (key != null) setLanguage(String(key));
                    }}
                    isDisabled={pending}
                  >
                    <Label>{t("language")}</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox aria-label={t("language")}>
                        {routing.locales.map((value) => {
                          const label = format.displayName(value, { type: "language" }) ?? value;
                          return (
                            <ListBox.Item key={value} id={value} textValue={label}>
                              {label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          );
                        })}
                      </ListBox>
                    </Select.Popover>
                  </Select>

                  <TextField
                    fullWidth
                    isRequired
                    value={recipients}
                    onChange={setRecipients}
                    isDisabled={pending}
                    isInvalid={invalid.length > 0 || tooMany}
                  >
                    <Label>{t("recipients")}</Label>
                    <TextArea rows={4} placeholder="finance@example.com" />
                    <Description>{t("recipientsHint", { max: MAX_REPORT_RECIPIENTS })}</Description>
                    <FieldError>
                      {invalid.length
                        ? t("recipientsInvalid", { list: format.list(invalid, "enumeration") })
                        : t("recipientsTooMany", { max: MAX_REPORT_RECIPIENTS })}
                    </FieldError>
                  </TextField>

                  {suggestions.length ? (
                    <SearchSelect
                      label={t("addPerson")}
                      placeholder={t("addPersonPlaceholder")}
                      items={suggestions.map((person) => ({
                        id: person.id,
                        label: person.alias,
                        detail: person.email,
                      }))}
                      value=""
                      onChange={(id) => {
                        const person = suggestions.find((row) => row.id === id);
                        if (person) setRecipients([...list, person.email].join("\n"));
                      }}
                      isDisabled={pending}
                    />
                  ) : null}

                  <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("enabled")}</Label>
                    </Switch.Content>
                    <Description>{t("enabledHint")}</Description>
                  </Switch>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!list.length || invalid.length > 0 || tooMany}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("submit", { mode })}
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
