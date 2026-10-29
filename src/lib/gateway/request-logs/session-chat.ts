import type { LogChatRequest, LogChatThread, LogChatTurn, TranscriptEntry } from "@/types/logs";

const ANCHOR_CHARS = 200;
const ENTRY_CHARS = 20_000;
const SYSTEM_ROLES = new Set(["system", "developer"]);

export type ChatSource = {
  request: Omit<LogChatRequest, "resent" | "repeated">;
  input: TranscriptEntry[];
  output: TranscriptEntry[];
};

type ThreadState = {
  thread: LogChatThread;
  anchor: string;
  inputLength: number;
  output: TranscriptEntry[];
};

function isSystem(entry: TranscriptEntry): boolean {
  return SYSTEM_ROLES.has(entry.role);
}

function sameEntry(a: TranscriptEntry, b: TranscriptEntry): boolean {
  return a.role === b.role && a.kind === b.kind && (a.name ?? "") === (b.name ?? "") && a.text.trim() === b.text.trim();
}

function head(entry: TranscriptEntry | undefined): string {
  return entry ? `${entry.role}\u0000${entry.kind}\u0000${entry.text.slice(0, ANCHOR_CHARS)}` : "";
}

function anchorOf(input: TranscriptEntry[]): string {
  const system = input.find(isSystem);
  const first = input.find((entry) => !isSystem(entry));
  return `${head(system)}\u0001${head(first)}`;
}

function clipped(entry: TranscriptEntry): TranscriptEntry {
  if (entry.text.length <= ENTRY_CHARS) return entry;
  return { ...entry, text: `${entry.text.slice(0, ENTRY_CHARS)}… [+${entry.text.length - ENTRY_CHARS} chars]` };
}

function echoedLength(tail: TranscriptEntry[], previous: TranscriptEntry[]): number {
  let at = 0;
  for (const entry of previous) {
    if (entry.kind === "reasoning") continue;
    while (tail[at]?.kind === "reasoning") at++;
    const candidate = tail[at];
    if (!candidate || !sameEntry(candidate, entry)) break;
    at++;
  }
  return at;
}

export class SessionChatBuilder {
  private states: ThreadState[] = [];

  add(source: ChatSource): void {
    const { input, output, request } = source;
    const anchor = anchorOf(input);
    const state = this.match(anchor, input.length);
    if (!state) {
      this.start(source, anchor);
      return;
    }
    const tail = input.slice(state.inputLength);
    const echoed = echoedLength(tail, state.output);
    const fresh = tail.slice(echoed).filter((entry) => !isSystem(entry));
    const repeated = !fresh.length && output.length > 0 && output.length === state.output.length && output.every((entry, index) => sameEntry(entry, state.output[index]!));
    const resent = state.inputLength + echoed - state.thread.system.length;
    state.thread.turns.push({
      request: { ...request, resent: Math.max(0, resent), repeated },
      input: fresh.map(clipped),
      output: repeated ? [] : output.map(clipped),
    });
    if (!state.thread.models.includes(request.model)) state.thread.models.push(request.model);
    state.inputLength = input.length;
    if (output.length) state.output = output;
  }

  threads(): LogChatThread[] {
    return this.states.map((state) => state.thread);
  }

  private match(anchor: string, length: number): ThreadState | undefined {
    let best: ThreadState | undefined;
    for (const state of this.states) {
      if (state.anchor !== anchor || state.inputLength > length) continue;
      if (!best || state.inputLength > best.inputLength) best = state;
    }
    return best;
  }

  private start(source: ChatSource, anchor: string): void {
    const { input, output, request } = source;
    const turn: LogChatTurn = {
      request: { ...request, resent: 0, repeated: false },
      input: input.filter((entry) => !isSystem(entry)).map(clipped),
      output: output.map(clipped),
    };
    this.states.push({
      thread: {
        id: request.id,
        system: input.filter(isSystem).map(clipped),
        models: [request.model],
        turns: [turn],
      },
      anchor,
      inputLength: input.length,
      output,
    });
  }
}
