"use client";

import { Button, Card } from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import type { PlaygroundSession } from "@/types/playground";

type SessionNavProps = {
  sessions: PlaygroundSession[];
  currentId: string | undefined;
  pending: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onCreate: () => void;
};

export function SessionPicker({
  sessions,
  currentId,
  pending,
  onSelect,
  onRemove,
  onCreate,
}: SessionNavProps) {
  const t = useTranslations("Playground");
  return (
    <div className="mb-3 flex items-center gap-2 md:hidden">
      <SearchSelect
        label={t("sessions")}
        hideLabel
        items={sessions.map((s) => ({ id: s.id, label: s.title || t("untitled") }))}
        value={currentId ?? ""}
        onChange={onSelect}
        className="min-w-0 flex-1"
      />
      <Button
        isIconOnly
        variant="ghost"
        isDisabled={pending}
        aria-label={t("deleteSession")}
        onPress={() => currentId && onRemove(currentId)}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
      <Button isIconOnly variant="secondary" isDisabled={pending} aria-label={t("newSession")} onPress={onCreate}>
        <Plus size={14} aria-hidden />
      </Button>
    </div>
  );
}

export default function SessionSidebar({
  sessions,
  currentId,
  pending,
  onSelect,
  onRemove,
  onCreate,
}: SessionNavProps) {
  const t = useTranslations("Playground");
  return (
    <Card render={(props) => <aside {...props} />} className="hidden w-64 shrink-0 md:flex">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title>{t("sessions")}</Card.Title>
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          isDisabled={pending}
          aria-label={t("newSession")}
          onPress={onCreate}
        >
          <Plus size={14} aria-hidden />
        </Button>
      </Card.Header>
      <nav aria-label={t("sessions")} className="min-h-0 flex-1 overflow-y-auto">
        <ul className="space-y-1">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-1">
              <Button
                fullWidth
                variant={s.id === currentId ? "secondary" : "ghost"}
                isDisabled={pending}
                aria-current={s.id === currentId ? "true" : undefined}
                className="justify-start"
                onPress={() => onSelect(s.id)}
              >
                <span className="truncate">{s.title || t("untitled")}</span>
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                isDisabled={pending}
                aria-label={t("deleteSession")}
                onPress={() => onRemove(s.id)}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      </nav>
    </Card>
  );
}
