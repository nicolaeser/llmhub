"use client";

import {
  Autocomplete,
  Description,
  EmptyState,
  Label,
  ListBox,
  SearchField,
  Tag,
  TagGroup,
  useFilter,
} from "@heroui/react";
import type { ReactNode } from "react";
import type { PickerItem } from "@/types/console";

export default function MultiPicker({
  label,
  description,
  placeholder,
  searchLabel,
  emptyLabel,
  items,
  selected,
  onChange,
  isDisabled,
}: {
  label: string;
  description?: ReactNode;
  placeholder: string;
  searchLabel: string;
  emptyLabel: string;
  items: PickerItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
  isDisabled?: boolean;
}) {
  const { contains } = useFilter({ sensitivity: "base" });
  const known = new Set(items.map((item) => item.id));
  const options: PickerItem[] = [
    ...items,
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id })),
  ];
  const labels = new Map(options.map((item) => [item.id, item.label]));

  return (
    <Autocomplete
      fullWidth
      selectionMode="multiple"
      placeholder={placeholder}
      value={selected}
      onChange={(keys) => onChange(Array.isArray(keys) ? keys.map(String) : [])}
      isDisabled={isDisabled}
    >
      <Label>{label}</Label>
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {({ defaultChildren, isPlaceholder }) =>
            isPlaceholder || selected.length === 0 ? (
              defaultChildren
            ) : (
              <TagGroup
                size="sm"
                aria-label={label}
                onRemove={(keys) => onChange(selected.filter((id) => !keys.has(id)))}
              >
                <TagGroup.List>
                  {selected.map((id) => (
                    <Tag key={id} id={id}>
                      {labels.get(id) ?? id}
                    </Tag>
                  ))}
                </TagGroup.List>
              </TagGroup>
            )
          }
        </Autocomplete.Value>
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <Autocomplete.Popover>
        <Autocomplete.Filter filter={contains}>
          <SearchField autoFocus aria-label={searchLabel} variant="secondary">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={searchLabel} />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox aria-label={label} renderEmptyState={() => <EmptyState>{emptyLabel}</EmptyState>}>
            {options.map((item) => (
              <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
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
