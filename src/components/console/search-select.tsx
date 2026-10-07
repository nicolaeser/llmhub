"use client";

import {
  Autocomplete,
  Description,
  EmptyState,
  Label,
  ListBox,
  SearchField,
  useFilter,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { PickerItem } from "@/types/console";

export default function SearchSelect({
  label,
  hideLabel,
  description,
  placeholder,
  items,
  value,
  onChange,
  disabledKeys,
  isDisabled,
  isRequired,
  className,
}: {
  label: string;
  hideLabel?: boolean;
  description?: ReactNode;
  placeholder?: string;
  items: PickerItem[];
  value: string;
  onChange: (id: string) => void;
  disabledKeys?: string[];
  isDisabled?: boolean;
  isRequired?: boolean;
  className?: string;
}) {
  const t = useTranslations("Common");
  const { contains } = useFilter({ sensitivity: "base" });
  const selected = items.find((item) => item.id === value);

  return (
    <Autocomplete
      fullWidth
      className={className}
      placeholder={placeholder}
      value={selected ? selected.id : null}
      onChange={(key) => {
        if (key != null) onChange(String(key));
      }}
      disabledKeys={disabledKeys}
      isDisabled={isDisabled}
      isRequired={isRequired}
    >
      <Label className={hideLabel ? "sr-only" : undefined}>{label}</Label>
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {({ defaultChildren, isPlaceholder }) =>
            isPlaceholder || !selected ? defaultChildren : <span className="truncate">{selected.label}</span>
          }
        </Autocomplete.Value>
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <Autocomplete.Popover>
        <Autocomplete.Filter filter={contains}>
          <SearchField autoFocus aria-label={t("search")} variant="secondary">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("search")} />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox aria-label={label} renderEmptyState={() => <EmptyState>{t("noResults")}</EmptyState>}>
            {items.map((item) => (
              <ListBox.Item
                key={item.id}
                id={item.id}
                textValue={item.detail ? `${item.label} ${item.detail}` : item.label}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{item.label}</span>
                  {item.detail ? <span className="truncate text-xs text-muted">{item.detail}</span> : null}
                </div>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
      {description ? <Description>{description}</Description> : null}
    </Autocomplete>
  );
}
