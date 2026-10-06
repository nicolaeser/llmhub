import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { headers } from "next/headers";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import AppProviders from "@/app/_components/app-providers";
import { formats } from "@/i18n/formats";
import "@/styles/globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Common");
  return {
    title: {
      template: t("titleTemplate"),
      default: t("appName"),
    },
    description: t("metaDescription"),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [locale, messages, requestHeaders] = await Promise.all([
    getLocale(),
    getMessages(),
    headers(),
  ]);

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <NextIntlClientProvider locale={locale} messages={messages} formats={formats}>
          <AppProviders nonce={requestHeaders.get("x-nonce") ?? undefined}>{children}</AppProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
