"use client";

import { ComboBox, Description, Input, Label, ListBox } from "@heroui/react";

function timeZones(current: string): string[] {
  const zones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
  return zones.includes(current) ? zones : [current, ...zones];
}

export default function TimeZonePicker({
  label,
  description,
  value,
  isDisabled,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  isDisabled: boolean;
  onChange: (timeZone: string) => void;
}) {
  return (
    <ComboBox
      fullWidth
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      isDisabled={isDisabled}
    >
      <Label>{label}</Label>
      <ComboBox.InputGroup>
        <Input />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <Description>{description}</Description>
      <ComboBox.Popover>
        <ListBox aria-label={label}>
          {timeZones(value).map((zone) => (
            <ListBox.Item key={zone} id={zone} textValue={zone}>
              {zone}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}
