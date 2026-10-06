"use client";

import type { ReactNode } from "react";
import { Card, Description, Input, Label, Switch, TextField } from "@heroui/react";

export function SettingSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        {subtitle ? <Card.Description>{subtitle}</Card.Description> : null}
      </Card.Header>
      {children}
    </Card>
  );
}

export function SettingText({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <TextField fullWidth value={value} onChange={onChange} isDisabled={disabled}>
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
  disabled,
  hint,
}: {
  label: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <Switch isSelected={isSelected} onChange={onChange} isDisabled={disabled}>
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
