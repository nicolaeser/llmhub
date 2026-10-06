import type { z } from "zod";
import type { adminSettingsSchema, alertWebhooksSchema } from "@/schemas/settings";
import type { WebhookEvent } from "@/types/gateway";

export type AdminSettings = z.infer<typeof adminSettingsSchema>;

export type AlertWebhookInput = z.infer<typeof alertWebhooksSchema>[number];

export type AlertWebhookView = {
  id: string;
  url: string;
  events: WebhookEvent[];
  secretSet: boolean;
};

export type AlertWebhookDraft = AlertWebhookInput & {
  key: string;
  secretSet: boolean;
};

export type AdminSettingsView = {
  settings: AdminSettings;
  aliases: string[];
  canManage: boolean;
  canManageScim: boolean;
  scimTokenSet: boolean;
  s3Ready: boolean;
  oidcEnv: boolean;
  smtpEnv: boolean;
  appUrl: string;
};
