import { z } from "zod";
import { modelAlias } from "@/lib/gateway/model-alias";

const alias = z.string().trim().min(1).max(200).transform(modelAlias);

const entryRef = {
  providerId: z.string().trim().min(1).max(64),
  upstreamId: z.string().trim().min(1).max(300),
};

export const catalogGroupActiveSchema = z.object({ alias, active: z.boolean() });

export const catalogGroupAutoRoutesSchema = z.object({ alias, autoRoutes: z.boolean() });

export const catalogEntryActiveSchema = z.object({ ...entryRef, active: z.boolean() });

export const catalogEntryAssignSchema = z.object({ ...entryRef, alias });
