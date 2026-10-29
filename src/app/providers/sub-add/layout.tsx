import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import BrandMark from "@/components/brand/brand-mark";
import AreaMessages from "@/components/i18n/area-messages";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("SubAdd");
  return {
    title: t("metaTitle"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function SubAddLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("Common");
  return (
    <main className="flex flex-1 flex-col items-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-xl space-y-6">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight">{t("appName")}</span>
        </div>
        <AreaMessages area="providers/sub-add">{children}</AreaMessages>
      </div>
    </main>
  );
}
