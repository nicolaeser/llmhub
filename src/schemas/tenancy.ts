import { z } from "zod";
import { MAX_PAUSE_HOURS } from "@/lib/keys/pause";

const tenancyRef = {
  kind: z.enum(["org", "team", "project", "member"]),
  id: z.string().trim().min(1).max(64),
};

export const pauseNodeSchema = z.object({
  ...tenancyRef,
  hours: z.number().int().min(0).max(MAX_PAUSE_HOURS).default(0),
});

export const resumeNodeSchema = z.object(tenancyRef);
