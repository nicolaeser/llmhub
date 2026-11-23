export type SortDirection = "ascending" | "descending";

export type ColumnSort = {
  column: string;
  direction: SortDirection;
};

export type SortValue = string | number | boolean | null;

export function columnSort(
  descriptor: { column?: unknown; direction?: string },
  current: ColumnSort | null,
): ColumnSort {
  const column = String(descriptor.column ?? "");
  if (!current || current.column !== column) return { column, direction: "descending" };
  return { column, direction: descriptor.direction === "ascending" ? "ascending" : "descending" };
}

export function descriptorOf(sort: ColumnSort): { column: string; direction: SortDirection } {
  return { column: sort.column, direction: sort.direction };
}

export function compareSortValues(left: SortValue, right: SortValue): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

export function sortByColumn<T>(
  rows: readonly T[],
  sort: ColumnSort | null,
  value: (row: T, column: string) => SortValue,
): T[] {
  if (!sort) return rows as T[];
  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const compared = compareSortValues(value(left.row, sort.column), value(right.row, sort.column));
      return compared === 0 ? left.index - right.index : compared * direction;
    })
    .map((entry) => entry.row);
}
