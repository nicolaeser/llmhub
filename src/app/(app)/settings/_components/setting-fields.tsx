"use client";

import { useId, type ReactNode } from "react";
import { Card, Description, Input, Label, Switch, TextField } from "@heroui/react";

export function SettingSection({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-x-10 gap-y-3 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="space-y-1 lg:pt-1">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
      </div>
      <Card className="min-w-0 gap-4">
        {children}
        {footer ? <Card.Footer>{footer}</Card.Footer> : null}
      </Card>
    </section>
  );
}

export function SettingText({
  label,
  value,
  onChange,
  isDisabled,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  isDisabled: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <TextField fullWidth value={value} onChange={onChange} isDisabled={isDisabled}>
      <Label>{label}</Label>
      <Input placeholder={placeholder} />
      {hint ? <Description>{hint}</Description> : null}
    </TextField>
  );
}

export function SettingSwitch({
  label,
  isSelected,
  onChange,
  isDisabled,
  hint,
}: {
  label: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled: boolean;
  hint?: string;
}) {
  return (
    <Switch isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>{label}</Label>
      </Switch.Content>
      {hint ? <Description>{hint}</Description> : null}
    </Switch>
  );
}
