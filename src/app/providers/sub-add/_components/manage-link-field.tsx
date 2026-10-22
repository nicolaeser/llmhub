"use client";

import { Surface } from "@heroui/react";
import CopyButton from "@/components/console/copy-button";

export default function ManageLinkField({ url, copyLabel }: { url: string; copyLabel: string }) {
  return (
    <div className="mt-2 flex min-w-0 items-start gap-2">
      <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
        <code className="font-mono text-sm break-all">{url}</code>
      </Surface>
      <CopyButton text={url} label={copyLabel} variant="secondary" />
    </div>
  );
}
