"use client";

import type { ReactNode } from "react";
import { Breadcrumbs } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import IconTile from "@/components/console/icon-tile";
import type { NodeLink, NodeRef } from "@/types/structure";
import { nodeKey, parseNodeRef } from "./tree-model";

export default function NodeHeader({
  icon,
  path,
  title,
  subtitle,
  chips,
  actions,
  onOpen,
}: {
  icon: LucideIcon;
  path: NodeLink[];
  title: string;
  subtitle: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  onOpen: (ref: NodeRef) => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <IconTile icon={icon} />
        <div className="min-w-0 space-y-1">
          {path.length > 1 ? (
            <Breadcrumbs
              className="flex-wrap"
              onAction={(key) => {
                const ref = parseNodeRef(String(key));
                if (ref) onOpen(ref);
              }}
            >
              {path.map((link) => (
                <Breadcrumbs.Item key={nodeKey(link)} id={nodeKey(link)}>
                  {link.alias}
                </Breadcrumbs.Item>
              ))}
            </Breadcrumbs>
          ) : null}
          <h2 className="text-lg font-semibold tracking-tight break-words">{title}</h2>
          <p className="text-sm text-muted">{subtitle}</p>
          {chips ? <div className="flex flex-wrap gap-1 pt-1">{chips}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
