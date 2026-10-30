import { Card, Separator, Skeleton } from "@heroui/react";
import { TABLE_FROM_LG } from "@/components/console/row-cards";

export type LoadingLayout =
  | "table"
  | "rows"
  | "cards"
  | "panels"
  | "columns"
  | "form"
  | "split"
  | "charts"
  | "chat"
  | "dashboard";

export type StatCount = 0 | 3 | 4;

const STAT_GRIDS = {
  3: "grid gap-3 sm:grid-cols-3",
  4: "grid grid-cols-2 gap-3 lg:grid-cols-4",
} as const;

const CELL_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5"] as const;

function times(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function TextSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="w-full space-y-2">
      {times(lines).map((line) => (
        <Skeleton key={line} className={`h-3 rounded-lg ${line === lines - 1 ? "w-3/5" : "w-full"}`} />
      ))}
    </div>
  );
}

export function HeaderSkeleton() {
  return (
    <div className="mb-6 flex items-start gap-3">
      <Skeleton className="mt-0.5 size-8 shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1 space-y-2 pt-1">
        <Skeleton className="h-5 w-48 max-w-full rounded-lg" />
        <Skeleton className="h-3.5 w-80 max-w-full rounded-lg" />
      </div>
    </div>
  );
}

const TAB_WIDTHS = ["w-24", "w-20", "w-28"] as const;

export function TabsSkeleton() {
  return (
    <div className="flex h-8.25 items-center gap-8 border-b border-border px-4">
      {TAB_WIDTHS.map((width) => (
        <Skeleton key={width} className={`h-3.5 rounded-lg ${width}`} />
      ))}
    </div>
  );
}

function StatCardSkeleton() {
  return (
    <Card className="gap-1.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-24 max-w-full rounded-lg" />
        <Skeleton className="size-7 shrink-0 rounded-xl" />
      </div>
      <Skeleton className="my-1 h-6 w-20 rounded-lg" />
    </Card>
  );
}

export function StatsSkeleton({ count }: { count: Exclude<StatCount, 0> }) {
  return (
    <div className={STAT_GRIDS[count]}>
      {times(count).map((item) => (
        <StatCardSkeleton key={item} />
      ))}
    </div>
  );
}

function ToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Skeleton className="h-10 w-full max-w-sm rounded-xl" />
      <Skeleton className="h-10 w-32 rounded-3xl" />
    </div>
  );
}

function RowCardSkeleton() {
  return (
    <Card>
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div className="w-full min-w-0 space-y-2">
          <Skeleton className="h-4 w-1/2 rounded-lg" />
          <Skeleton className="h-3 w-1/3 rounded-lg" />
        </div>
        <Skeleton className="size-8 shrink-0 rounded-lg" />
      </Card.Header>
      <div className="flex gap-1">
        <Skeleton className="h-5 w-16 rounded-2xl" />
        <Skeleton className="h-5 w-20 rounded-2xl" />
      </div>
      <Card.Content>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {times(4).map((cell) => (
            <div key={cell} className="space-y-1.5">
              <Skeleton className="h-2.5 w-12 rounded-lg" />
              <Skeleton className={`h-3.5 rounded-lg ${CELL_WIDTHS[cell]}`} />
            </div>
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 lg:hidden">
        {times(Math.min(rows, 3)).map((row) => (
          <RowCardSkeleton key={row} />
        ))}
      </div>
      <Card variant="secondary" className={`gap-3 ${TABLE_FROM_LG}`}>
        <div className="flex gap-6 px-4">
          {times(columns).map((column) => (
            <Skeleton key={column} className="h-3 flex-1 rounded-lg" />
          ))}
        </div>
        <Card>
          {times(rows).map((row) => (
            <div key={row}>
              {row ? <Separator /> : null}
              <div className="flex items-center gap-6 py-3">
                {times(columns).map((column) => (
                  <div key={column} className="flex-1 space-y-1.5">
                    <Skeleton className={`h-3.5 rounded-lg ${CELL_WIDTHS[(row + column) % CELL_WIDTHS.length]}`} />
                    {column === 0 ? <Skeleton className="h-2.5 w-1/3 rounded-lg" /> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Card>
      </Card>
    </>
  );
}

export function CardSkeleton({ variant = "default", lines = 2 }: { variant?: "default" | "secondary"; lines?: number }) {
  return (
    <Card variant={variant}>
      <Card.Header className="flex-row items-start gap-3">
        <Skeleton className="size-9 shrink-0 rounded-xl" />
        <div className="w-full min-w-0 space-y-2">
          <Skeleton className="h-4 w-2/5 rounded-lg" />
          <Skeleton className="h-3 w-3/5 rounded-lg" />
        </div>
      </Card.Header>
      <Card.Content>
        <TextSkeleton lines={lines} />
      </Card.Content>
      <Card.Footer className="gap-2">
        <Skeleton className="h-8 w-24 rounded-3xl" />
        <Skeleton className="h-8 w-8 rounded-3xl" />
      </Card.Footer>
    </Card>
  );
}

function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {times(count).map((card) => (
        <CardSkeleton key={card} />
      ))}
    </div>
  );
}

function PanelsSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div className="space-y-5">
      {times(count).map((panel) => (
        <Card key={panel} className="gap-5">
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="flex w-full min-w-0 items-start gap-3">
              <Skeleton className="size-9 shrink-0 rounded-xl" />
              <div className="w-full min-w-0 space-y-2">
                <Skeleton className="h-4 w-40 max-w-full rounded-lg" />
                <Skeleton className="h-3 w-64 max-w-full rounded-lg" />
              </div>
            </div>
            <Skeleton className="h-8 w-28 shrink-0 rounded-3xl" />
          </Card.Header>
          <Card.Content className="gap-3">
            <div className="grid gap-3 lg:grid-cols-2">
              <CardSkeleton variant="secondary" lines={3} />
              <CardSkeleton variant="secondary" lines={3} />
            </div>
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}

function ColumnsSkeleton() {
  return (
    <div className="space-y-5">
      <Card className="flex-row flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32 rounded-lg" />
          <Skeleton className="h-3.5 w-48 max-w-full rounded-lg" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-6 w-16 rounded-2xl" />
          <Skeleton className="h-6 w-20 rounded-2xl" />
        </div>
      </Card>
      <div className="grid items-start gap-5 xl:grid-cols-2">
        {times(2).map((column) => (
          <div key={column} className="space-y-5">
            <CardSkeleton lines={3} />
            <CardSkeleton lines={2} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {times(rows).map((row) => (
        <Skeleton key={row} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function DetailsSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {times(6).map((fact) => (
          <div key={fact} className="space-y-1.5">
            <Skeleton className="h-2.5 w-16 rounded-lg" />
            <Skeleton className={`h-3.5 rounded-lg ${CELL_WIDTHS[fact % CELL_WIDTHS.length]}`} />
          </div>
        ))}
      </div>
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

function FieldSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3.5 w-28 rounded-lg" />
      <Skeleton className="h-10 w-full rounded-xl" />
      <Skeleton className="h-3 w-3/5 rounded-lg" />
    </div>
  );
}

function FormSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="space-y-5">
      {times(sections).map((section) => (
        <Card key={section} className="gap-4">
          <Card.Header className="space-y-2">
            <Skeleton className="h-4 w-44 max-w-full rounded-lg" />
            <Skeleton className="h-3 w-80 max-w-full rounded-lg" />
          </Card.Header>
          <div className="grid gap-4 md:grid-cols-2 md:items-start">
            <FieldSkeleton />
            <FieldSkeleton />
          </div>
        </Card>
      ))}
    </div>
  );
}

function SplitSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
      <Card className="gap-3">
        <Skeleton className="h-10 w-full rounded-xl" />
        {times(6).map((item) => (
          <div key={item} className={`flex items-center gap-2 ${item % 3 ? "pl-5" : ""}`}>
            <Skeleton className="size-7 shrink-0 rounded-lg" />
            <Skeleton className="h-3.5 w-full rounded-lg" />
          </div>
        ))}
      </Card>
      <div className="min-w-0 space-y-5">
        <div className="flex items-start gap-3">
          <Skeleton className="size-9 shrink-0 rounded-xl" />
          <div className="w-full min-w-0 space-y-2">
            <Skeleton className="h-5 w-48 max-w-full rounded-lg" />
            <Skeleton className="h-3.5 w-72 max-w-full rounded-lg" />
          </div>
        </div>
        <Card className="gap-4">
          <Skeleton className="h-4 w-32 rounded-lg" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {times(4).map((cell) => (
              <div key={cell} className="space-y-2">
                <Skeleton className="h-3 w-16 rounded-lg" />
                <Skeleton className="h-6 w-20 rounded-lg" />
              </div>
            ))}
          </div>
          <Skeleton className="h-2 w-full rounded-lg" />
        </Card>
        <CardSkeleton lines={3} />
      </div>
    </div>
  );
}

function FilterFieldSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3.5 w-20 rounded-lg" />
      <Skeleton className="h-10 w-full rounded-xl" />
    </div>
  );
}

export function FiltersSkeleton({ fields, toolbar = false }: { fields: number; toolbar?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      {toolbar ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Skeleton className="h-10 w-32 rounded-3xl" />
          <Skeleton className="h-10 w-36 rounded-3xl" />
        </div>
      ) : null}
      <div className={`${toolbar ? "grid" : "hidden md:grid"} gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`}>
        {times(fields).map((field) => (
          <div key={field} className={toolbar && field === 0 ? undefined : "hidden md:block"}>
            <FilterFieldSkeleton />
          </div>
        ))}
      </div>
      {toolbar ? null : (
        <div className="hidden flex-wrap items-center gap-3 md:flex">
          <Skeleton className="h-6 w-40 rounded-3xl" />
          <Skeleton className="h-10 w-24 rounded-3xl" />
          <Skeleton className="h-10 w-20 rounded-3xl" />
        </div>
      )}
      <Card className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-4 w-28 rounded-lg" />
          <Skeleton className="size-4 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

function ChartCardSkeleton() {
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-4 w-32 rounded-lg" />
        <Skeleton className="h-3 w-24 rounded-lg" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </Card>
  );
}

export function ChartsSkeleton() {
  return (
    <div className="space-y-5">
      <ChartCardSkeleton />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ChartCardSkeleton />
        </div>
        <div className="lg:col-span-2">
          <ChartCardSkeleton />
        </div>
      </div>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-5">
      <FiltersSkeleton fields={8} toolbar />
      <div className="space-y-3">
        <StatsSkeleton count={4} />
        <StatsSkeleton count={3} />
      </div>
      <ChartsSkeleton />
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="flex min-h-[60vh] flex-col gap-4 md:flex-row">
      <Card className="hidden w-64 shrink-0 gap-3 md:flex">
        <Skeleton className="h-9 w-full rounded-3xl" />
        {times(5).map((item) => (
          <Skeleton key={item} className="h-9 w-full rounded-xl" />
        ))}
      </Card>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
        <Card className="min-h-80 flex-1 justify-between gap-6">
          <div className="space-y-4">
            <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
            <Skeleton className="h-20 w-3/4 rounded-2xl" />
            <Skeleton className="ml-auto h-10 w-1/3 rounded-2xl" />
          </div>
          <Skeleton className="h-12 w-full rounded-2xl" />
        </Card>
      </div>
    </div>
  );
}

function ChecklistSkeleton({ rows }: { rows: number }) {
  return (
    <Card className="gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="w-full min-w-0 space-y-2">
          <Skeleton className="h-4 w-32 rounded-lg" />
          <Skeleton className="h-3 w-64 max-w-full rounded-lg" />
        </div>
        <Skeleton className="h-5 w-20 shrink-0 rounded-2xl" />
      </div>
      <div>
        {times(rows).map((row) => (
          <div key={row}>
            {row ? <Separator /> : null}
            <div className="flex items-center gap-3 py-3">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <Skeleton className={`h-3.5 rounded-lg ${CELL_WIDTHS[row % CELL_WIDTHS.length]}`} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-5 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <ChecklistSkeleton rows={5} />
        </div>
        <div className="min-w-0 xl:col-span-2">
          <ChecklistSkeleton rows={1} />
        </div>
      </div>
      <div className="space-y-3">
        <div className="space-y-2">
          <Skeleton className="h-4 w-48 max-w-full rounded-lg" />
          <Skeleton className="h-3 w-64 max-w-full rounded-lg" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {times(4).map((card) => (
            <Card key={card} className="gap-3">
              <Skeleton className="size-7 rounded-xl" />
              <Skeleton className="h-4 w-24 rounded-lg" />
              <TextSkeleton lines={2} />
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LayoutSkeleton({ layout }: { layout: LoadingLayout }) {
  if (layout === "dashboard") return <DashboardSkeleton />;
  if (layout === "cards") return <CardGridSkeleton />;
  if (layout === "panels") return <PanelsSkeleton />;
  if (layout === "columns") return <ColumnsSkeleton />;
  if (layout === "form") return <FormSkeleton />;
  if (layout === "split") return <SplitSkeleton />;
  if (layout === "charts") return <UsageSkeleton />;
  if (layout === "chat") return <ChatSkeleton />;
  if (layout === "rows") return <TableSkeleton />;
  return (
    <div className="space-y-5">
      <ToolbarSkeleton />
      <TableSkeleton />
    </div>
  );
}
