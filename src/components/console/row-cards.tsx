import type { ReactNode } from "react";
import { Card } from "@heroui/react";

export type RowDetail = {
  label: ReactNode;
  value: ReactNode;
  wide?: boolean;
};

export const TABLE_FROM_LG = "max-lg:hidden";
export const TABLE_FROM_XL = "max-xl:hidden";

export function RowCards({
  label,
  until = "lg",
  children,
}: {
  label: string;
  until?: "lg" | "xl";
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className={until === "xl" ? "grid grid-cols-1 gap-3 xl:hidden" : "grid grid-cols-1 gap-3 lg:hidden"}
    >
      {children}
    </ul>
  );
}

export default function RowCard({
  title,
  description,
  aside,
  chips,
  details = [],
  actions,
  variant = "default",
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  chips?: ReactNode;
  details?: RowDetail[];
  actions?: ReactNode;
  variant?: "default" | "secondary" | "tertiary";
}) {
  return (
    <Card<"li"> variant={variant} render={(props) => <li {...props} />}>
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title className="break-words">{title}</Card.Title>
          {description ? <Card.Description className="break-words">{description}</Card.Description> : null}
        </div>
        {aside ? <div className="flex shrink-0 items-center gap-1">{aside}</div> : null}
      </Card.Header>
      {chips ? <div className="flex flex-wrap gap-1">{chips}</div> : null}
      {details.length ? (
        <Card.Content>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {details.map((detail, index) => (
              <div key={index} className={detail.wide ? "col-span-2 min-w-0" : "min-w-0"}>
                <dt className="text-xs text-muted">{detail.label}</dt>
                <dd className="text-sm break-words text-foreground">{detail.value}</dd>
              </div>
            ))}
          </dl>
        </Card.Content>
      ) : null}
      {actions ? <Card.Footer className="flex-wrap gap-2">{actions}</Card.Footer> : null}
    </Card>
  );
}
