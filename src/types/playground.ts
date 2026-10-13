type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type PlaygroundMessage = { role: "user" | "assistant"; content: string | ContentPart[] };

export type PlaygroundSession = {
  id: string;
  title: string;
  model: string;
  system: string;
  messages: PlaygroundMessage[];
  updatedAt: number;
};

export type ReplayDraft = {
  system: string;
  history: PlaygroundMessage[];
  prompt: { text: string; images: string[] };
  tools: unknown[];
  dropped: boolean;
};

export type PlaygroundReplay = ReplayDraft & {
  id: string;
  model: string;
  truncated: boolean;
  masked: boolean;
};
