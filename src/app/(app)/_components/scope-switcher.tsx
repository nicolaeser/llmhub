"use client";

import { Button, Description, Dropdown, Header, Label, Spinner, Tooltip } from "@heroui/react";
import { Building2, ChevronsUpDown, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { useConsoleScope } from "./console-scope";

const PLATFORM_KEY = "platform";

type Variant = "expanded" | "rail" | "drawer";

const ROW = "flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left";

export default function ScopeSwitcher({ variant }: { variant: Variant }) {
  const t = useTranslations("Sidebar.scope");
  const { scope, companies, canSwitch, shown, pending, switchTo, refresh } = useConsoleScope();

  if (!shown) return null;

  const company = scope.kind === "company";
  const icon = company ? Building2 : ShieldCheck;
  const name = company ? scope.alias : t("platform");
  const hint = company ? t("companyHint") : t("platformHint");
  const label = t("label", { kind: scope.kind, alias: company ? scope.alias : "" });
  const rail = variant === "rail";
  const container = rail ? "flex justify-center pb-2" : "px-2 pb-2";

  const summary = (
    <>
      <IconTile icon={icon} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className="block truncate text-xs text-muted">{hint}</span>
      </span>
    </>
  );

  if (!canSwitch) {
    return rail ? (
      <div className={container}>
        <Tooltip delay={0} closeDelay={0}>
          <Tooltip.Trigger role="img" aria-label={label} className="flex size-10 items-center justify-center">
            <IconTile icon={icon} size="sm" />
          </Tooltip.Trigger>
          <Tooltip.Content placement="right">{label}</Tooltip.Content>
        </Tooltip>
      </div>
    ) : (
      <div className={container}>
        <div className={ROW}>{summary}</div>
      </div>
    );
  }

  const menu = (
    <Dropdown.Popover placement={rail ? "right top" : "bottom start"} className="min-w-64 max-w-[calc(100vw-2rem)]">
      <Dropdown.Menu
        aria-label={t("switch")}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[company ? scope.id : PLATFORM_KEY]}
        onSelectionChange={(keys) => {
          if (keys === "all") return;
          const key = [...keys][0];
          if (key != null) switchTo(key === PLATFORM_KEY ? null : String(key));
        }}
      >
        <Dropdown.Item id={PLATFORM_KEY} textValue={t("platform")}>
          <ShieldCheck size={16} aria-hidden className="shrink-0 text-accent" />
          <div className="flex min-w-0 flex-1 flex-col">
            <Label>{t("platform")}</Label>
            <Description>{t("platformHint")}</Description>
          </div>
          <Dropdown.ItemIndicator />
        </Dropdown.Item>
        <Dropdown.Section>
          <Header>{t("companies")}</Header>
          {companies.map((row) => (
            <Dropdown.Item key={row.id} id={row.id} textValue={row.alias}>
              <Building2 size={16} aria-hidden className="shrink-0 text-muted" />
              <Label className="min-w-0 flex-1 break-words">{row.alias}</Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Section>
      </Dropdown.Menu>
    </Dropdown.Popover>
  );

  const onOpenChange = (open: boolean) => {
    if (open) refresh();
  };

  if (rail) {
    return (
      <div className={container}>
        <Dropdown onOpenChange={onOpenChange}>
          <Tooltip delay={0} closeDelay={0}>
            <Button isIconOnly variant="ghost" aria-label={t("trigger", { current: label })} isPending={pending}>
              {({ isPending }) =>
                isPending ? <Spinner size="sm" color="current" /> : <IconTile icon={icon} size="sm" />
              }
            </Button>
            <Tooltip.Content placement="right">{label}</Tooltip.Content>
          </Tooltip>
          {menu}
        </Dropdown>
      </div>
    );
  }

  return (
    <div className={container}>
      <Dropdown onOpenChange={onOpenChange}>
        <Dropdown.Trigger
          aria-label={t("trigger", { current: label })}
          isPending={pending}
          className={`${ROW} hover:bg-foreground/5 motion-safe:transition-colors`}
        >
          {summary}
          {pending ? (
            <Spinner size="sm" color="current" />
          ) : (
            <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-muted" />
          )}
        </Dropdown.Trigger>
        {menu}
      </Dropdown>
    </div>
  );
}
