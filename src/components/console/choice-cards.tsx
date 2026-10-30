"use client";

import { Card, Description, Label, Radio, RadioGroup } from "@heroui/react";

export type Choice<T extends string> = { id: T; label: string; hint: string };

export default function ChoiceCards<T extends string>({
  label,
  value,
  options,
  onChange,
  description,
  isDisabled,
  columns = 3,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (next: T) => void;
  description?: string;
  isDisabled?: boolean;
  columns?: 2 | 3;
}) {
  return (
    <RadioGroup
      value={value}
      onChange={(key) => {
        const next = options.find((option) => option.id === key);
        if (next) onChange(next.id);
      }}
      isDisabled={isDisabled}
      className="gap-2"
    >
      <Label>{label}</Label>
      <div className={columns === 2 ? "grid gap-2 sm:grid-cols-2" : "grid gap-2 sm:grid-cols-3"}>
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Card
              key={option.id}
              variant="secondary"
              className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
            >
              <Radio value={option.id} className="mt-0 h-full w-full">
                <Radio.Content className="h-full w-full items-start gap-3 p-3">
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  <span className="min-w-0 flex-1 space-y-1">
                    <Label>{option.label}</Label>
                    <span className="block text-xs font-normal text-muted">{option.hint}</span>
                  </span>
                </Radio.Content>
              </Radio>
            </Card>
          );
        })}
      </div>
      {description ? <Description>{description}</Description> : null}
    </RadioGroup>
  );
}
