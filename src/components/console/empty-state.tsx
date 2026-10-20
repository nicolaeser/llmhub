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
    <Card className="w-full items-center gap-5 px-6 py-14 text-center">
      <IconTile icon={icon} size="xl" />
      <Card.Header className="items-center gap-1.5">
        <Card.Title className="text-lg font-semibold tracking-tight">{title}</Card.Title>
        {description ? (
          <Card.Description className="max-w-md text-balance">{description}</Card.Description>
        ) : null}
      </Card.Header>
      {action ? <Card.Footer className="flex-wrap justify-center gap-2">{action}</Card.Footer> : null}
    </Card>
  );
}
