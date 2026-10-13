import { chatCompletionsRoute } from "@/lib/gateway/endpoints/chat-completions-route";

export const maxDuration = 300;

export const POST = chatCompletionsRoute("subscription");
