import type { ReactNode } from "react";
import { clientMessages, type ClientMessageArea } from "@/i18n/client-messages";
import MessagesProvider from "./messages-provider";

export default async function AreaMessages({ area, children }: { area: ClientMessageArea; children: ReactNode }) {
  return <MessagesProvider messages={await clientMessages(area)}>{children}</MessagesProvider>;
}
