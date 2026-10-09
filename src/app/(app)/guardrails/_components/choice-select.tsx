"use client";

import { Description, Label, ListBox, Select } from "@heroui/react";

export default function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  description,
  isDisabled,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (next: T) => void;
  description?: string;
  isDisabled?: boolean;
}) {
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => {
        const next = options.find((option) => option.id === key);
        if (next) onChange(next.id);
      }}
      isDisabled={isDisabled}
      aria-label={label}
      fullWidth
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={label}>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      {description ? <Description>{description}</Description> : null}
    </Select>
  );
}
