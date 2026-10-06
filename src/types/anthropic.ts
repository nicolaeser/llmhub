import type { z } from "zod";
import type {
  messagesContentBlockSchema,
  messagesRequestSchema,
  messagesToolSchema,
} from "@/schemas/anthropic";

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

export type MessagesContentBlock = z.infer<typeof messagesContentBlockSchema>;

export type MessagesTool = z.infer<typeof messagesToolSchema>;

export type DataUrl = { mediaType: string; data: string };

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type MessagesStreamOptions = { inputTokens?: number };
