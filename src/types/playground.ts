type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type Msg = { role: "user" | "assistant"; content: string | ContentPart[] };

export type Session = {
  id: string;
  title: string;
  model: string;
  messages: Msg[];
  updatedAt: number;
};
