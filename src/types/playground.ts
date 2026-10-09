type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type Msg = { role: "user" | "assistant"; content: string | ContentPart[] };

export type Session = {
  id: string;
  title: string;
  model: string;
  system: string;
  messages: Msg[];
  updatedAt: number;
};

export type ReplayDraft = {
  system: string;
  history: Msg[];
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
