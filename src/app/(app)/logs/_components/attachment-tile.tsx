"use client";

import { Card } from "@heroui/react";
import { Download, FileText, Image as ImageGlyph, Music, Paperclip, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { TranscriptEntry } from "@/types/logs";

const MEDIA_ICONS: Record<string, LucideIcon> = { image: ImageGlyph, audio: Music, file: FileText };

function attachmentHref(id: string): string {
  return `/internal-api/logs/attachments/${encodeURIComponent(id)}`;
}

export default function AttachmentTile({ entry }: { entry: TranscriptEntry }) {
  const t = useTranslations("Logs.detail");
  const Icon = MEDIA_ICONS[entry.text] ?? Paperclip;
  const stored = entry.attachment;
  const href = stored ? attachmentHref(stored.id) : null;
  const label = t("media", { media: entry.text });

  return (
    <Card variant="tertiary" className="w-fit max-w-full gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Icon size={16} aria-hidden className="shrink-0 text-accent" />
        <span className="font-medium text-foreground">{label}</span>
        {entry.name ? <span className="min-w-0 truncate font-mono text-xs text-muted">{entry.name}</span> : null}
      </div>
      {stored && href && stored.contentType.startsWith("image/") ? (
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t("attachmentOpen", { media: entry.text })}>
          <img
            src={href}
            alt={t("attachmentAlt", { media: entry.text, name: entry.name ?? "" })}
            loading="lazy"
            decoding="async"
            className="block max-h-96 max-w-full"
          />
        </a>
      ) : null}
      {stored && href && stored.contentType.startsWith("audio/") ? (
        <audio controls preload="none" src={href} aria-label={label} className="max-w-full" />
      ) : null}
      {stored && href && !stored.contentType.startsWith("image/") && !stored.contentType.startsWith("audio/") ? (
        <a href={href} download className="flex items-center gap-1 text-xs text-accent underline underline-offset-2">
          <Download size={14} aria-hidden />
          {t("attachmentDownload")}
        </a>
      ) : null}
      {entry.url ? (
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="block text-xs break-all text-accent underline underline-offset-2"
        >
          {entry.url}
        </a>
      ) : null}
      {!stored && !entry.url ? <p className="max-w-sm text-xs text-muted">{t("attachmentMissing")}</p> : null}
    </Card>
  );
}
