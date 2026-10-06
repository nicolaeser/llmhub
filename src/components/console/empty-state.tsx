import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="w-full items-center gap-4 px-6 py-16 text-center">
      <div className="grid size-12 place-items-center rounded-xl bg-accent/10 text-accent">
        <Icon size={20} aria-hidden />
      </div>
      <Card.Header className="items-center gap-2">
        <Card.Title className="text-lg font-semibold tracking-tight">{title}</Card.Title>
        {description ? (
          <Card.Description className="max-w-md">{description}</Card.Description>
        ) : null}
      </Card.Header>
      {action ? <Card.Footer>{action}</Card.Footer> : null}
    </Card>
  );
}
