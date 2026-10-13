"use client";

import { useState } from "react";
import {
  Button,
  Card,
  Description,
  Label,
  Switch,
} from "@heroui/react";
import { Plus, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import SearchSelect from "@/components/console/search-select";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useAssistantSession } from "@/app/(app)/_components/assistant-session";
import { loadAssistantAction } from "./_action";
import AssistantComposer from "./_components/assistant-composer";
import AssistantTools from "./_components/assistant-tools";
import AssistantTranscript from "./_components/assistant-transcript";

export default function AssistantPage() {
  const t = useTranslations("Assistant");
  const session = useAssistantSession();
  const chooseModel = session?.chooseModel;
  const [input, setInput] = useState("");
  const page = useActionData(loadAssistantAction, (res) => chooseModel?.(res.models, res.defaultModel));

  if (!session?.enabled || page.error === "FORBIDDEN") {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState
          icon={Sparkles}
          title={t("forbiddenTitle")}
          description={t("forbidden")}
        />
      </div>
    );
  }

  if (!page.data) {
    return <PageStatus title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const { models, modelLocked, tools, canWrite } = page.data;

  function send(text = input) {
    if (!text.trim() || session?.pending) return;
    setInput("");
    void session?.send(text);
  }

  const writeState = !canWrite ? "unavailable" : session.allowWrite ? "on" : "off";

  return (
    <div className="flex min-h-[70vh] flex-col md:h-[calc(100vh-7rem)]">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            variant="secondary"
            isDisabled={session.messages.length === 0}
            onPress={() => {
              session.reset();
              setInput("");
            }}
          >
            <Plus size={14} aria-hidden />
            {t("newChat")}
          </Button>
        }
      />
      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <SearchSelect
          label={t("model")}
          placeholder={t("noModels")}
          items={models.map((alias) => ({ id: alias, label: alias }))}
          value={session.model}
          onChange={session.setModel}
          isDisabled={modelLocked || models.length === 0}
          description={modelLocked ? t("modelLocked") : undefined}
        />
        <Switch
          isSelected={canWrite && session.allowWrite}
          onChange={session.setAllowWrite}
          isDisabled={!canWrite}
          aria-label={t("write.label")}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("write.label")}</Label>
          </Switch.Content>
          <Description>{t("write.hint", { state: writeState })}</Description>
        </Switch>
      </div>
      <AssistantTools tools={tools} allowWrite={canWrite && session.allowWrite} />
      <Card className="min-h-0 flex-1 gap-0 p-0">
        <AssistantTranscript
          messages={session.messages}
          pending={session.pending}
          error={session.error}
          onSuggest={send}
        />
        <AssistantComposer
          value={input}
          pending={session.pending}
          allowWrite={canWrite && session.allowWrite}
          onChange={setInput}
          onSend={() => send()}
          onStop={session.stop}
        />
      </Card>
    </div>
  );
}
