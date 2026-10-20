"use client";

import { Alert, Button } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import AccountShell from "@/app/account/_components/account-shell";
import { errorDigest } from "@/lib/utils/error-digest";

export default function AccountError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("Error.boundary");
  const tCommon = useTranslations("Common");
  const digest = errorDigest(error);
  return (
    <AccountShell
      title={t("title")}
      footer={
        <Link href="/" className="text-accent">
          {tCommon("goHome")}
        </Link>
      }
    >
      <div className="space-y-5">
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("pageDescription")}</Alert.Title>
            {digest ? <Alert.Description className="break-all">{t("errorId", { id: digest })}</Alert.Description> : null}
          </Alert.Content>
        </Alert>
        <Button fullWidth size="lg" onPress={retry}>
          <RotateCcw size={16} aria-hidden />
          {t("tryAgain")}
        </Button>
      </div>
    </AccountShell>
  );
}
