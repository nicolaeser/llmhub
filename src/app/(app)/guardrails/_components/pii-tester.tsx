"use client";

import { useState, useTransition } from "react";
import { Button, Card, Spinner, Surface, TextArea, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { testPiiAction } from "../_action";

const SAMPLE =
  "Email jane@acme.com, SSN 123-45-6789, card 4111 1111 1111 1111, JWT eyJhbGciOiJIUzI1NiJ9.aa.bb, sk-hub-examplekey";

export default function PiiTester() {
  const t = useTranslations("Guardrails");
  const tError = useTranslations("Error");
  const [sample, setSample] = useState(SAMPLE);
  const [preview, setPreview] = useState("");
  const [pending, start] = useTransition();

  return (
    <Card variant="secondary">
      <Card.Header>
        <Card.Title>{t("tester")}</Card.Title>
        <Card.Description>{t("testerHint")}</Card.Description>
      </Card.Header>
      <TextArea
        fullWidth
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        aria-label={t("tester")}
        className="min-h-24"
      />
      <Button
        variant="secondary"
        className="self-start"
        aria-label={t("redact")}
        isPending={pending}
        onPress={() =>
          start(async () => {
            const result = await testPiiAction(sample);
            if (isActionFail(result)) {
              toast.danger(tError("code", { code: result.error }));
              return;
            }
            setPreview(result.redacted);
          })
        }
      >
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : null}
            {t("redact")}
          </>
        )}
      </Button>
      {preview ? (
        <Surface className="overflow-auto rounded-xl p-3">
          <pre className="text-xs whitespace-pre-wrap">{preview}</pre>
        </Surface>
      ) : null}
    </Card>
  );
}
