import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import IconTile from "@/components/console/icon-tile";

export default function EmptyState({
  icon,
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
    <Card className="w-full items-center gap-4 px-6 py-12 text-center">
      <IconTile icon={icon} size="lg" />
      <Card.Header className="items-center gap-1">
        <Card.Title className="text-base font-semibold tracking-tight">{title}</Card.Title>
        {description ? (
          <Card.Description className="max-w-md text-balance">{description}</Card.Description>
        ) : null}
      </Card.Header>
      {action ? <Card.Footer className="flex-wrap justify-center gap-2 pt-1">{action}</Card.Footer> : null}
    </Card>
  );
}
