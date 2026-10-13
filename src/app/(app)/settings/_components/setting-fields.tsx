"use client";

import type { ReactNode } from "react";
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
  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        {subtitle ? <Card.Description>{subtitle}</Card.Description> : null}
      </Card.Header>
      {children}
      {footer ? <Card.Footer>{footer}</Card.Footer> : null}
    </Card>
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
