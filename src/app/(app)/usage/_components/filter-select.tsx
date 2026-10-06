"use client";

import { Label, ListBox, Select } from "@heroui/react";

export default function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  allLabel: string;
  onChange: (next: string) => void;
}) {
  return (
    <Select
      selectedKey={value || "all"}
      onSelectionChange={(key) => {
        const next = String(key) === "all" ? "" : String(key);
        onChange(next);
      }}
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
          <ListBox.Item id="all" textValue={allLabel}>
            {allLabel}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {options.map((name) => (
            <ListBox.Item key={name} id={name} textValue={name}>
              {name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
