"use client";

import type { ReactNode } from "react";
import { RouterProvider, Toast } from "@heroui/react";
import { useRouter } from "@/i18n/routing";
import { ThemeProvider } from "next-themes";
import { navigateAppHref } from "@/lib/http/app-navigation";

export default function AppProviders({
  children,
  nonce,
}: {
  children: ReactNode;
  nonce?: string;
}) {
  const router = useRouter();

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
      nonce={nonce}
    >
      <RouterProvider
        navigate={(href) =>
          navigateAppHref(href, (path) => {
            void router.push(path);
          })
        }
      >
        <Toast.Provider />
        {children}
      </RouterProvider>
    </ThemeProvider>
  );
}
