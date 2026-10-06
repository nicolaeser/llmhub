"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Description,
  Label,
  ListBox,
  Select,
  Spinner,
  Switch,
} from "@heroui/react";
import { Plus, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import { isActionFail } from "@/lib/http/action-result";
import { useAssistantSession } from "@/app/(app)/_components/assistant-session";
import { loadAssistantAction } from "./_action";
import AssistantComposer from "./_components/assistant-composer";
import AssistantTranscript from "./_components/assistant-transcript";

export default function AssistantPage() {
  const t = useTranslations("Assistant");
  const tCommon = useTranslations("Common");
  const session = useAssistantSession();
  const chooseModel = session?.chooseModel;
  const [models, setModels] = useState<string[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadAssistantAction().then((res) => {
      if (cancelled) return;
      if (isActionFail(res)) {
        setFailure(res.error);
      } else {
        setModels(res.models);
        setCanWrite(res.canWrite);
        chooseModel?.(res.models, res.defaultModel);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [chooseModel]);

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  if (!session?.enabled || failure === "FORBIDDEN") {
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

  if (failure) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{t("loadFailed")}</Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    );
  }

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
        <Select
          selectedKey={session.model || null}
          onSelectionChange={(key) => {
            if (key !== null) session.setModel(String(key));
          }}
          aria-label={t("model")}
          fullWidth
          isDisabled={models.length === 0}
          placeholder={t("noModels")}
        >
          <Label>{t("model")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("model")}>
              {models.map((alias) => (
                <ListBox.Item key={alias} id={alias} textValue={alias}>
                  {alias}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
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
