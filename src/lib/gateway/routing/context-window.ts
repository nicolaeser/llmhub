import { GateError } from "@/lib/gateway/errors";
import { logger } from "@/lib/logging/logger";
import type { LogMeta } from "@/types/logging";
import type { ContextDecision, ContextDemand, ContextPlan, ModelFacts } from "@/types/routing";

const OVERFLOW_CODES = new Set(["context_length_exceeded", "model_context_window_exceeded"]);
const OVERFLOW_MESSAGE =
  /prompt is too long|input length and `?max_tokens`? exceed context limit|maximum context length|maximum prompt length|exceeds? the (?:model's )?context (?:window|length)|context (?:window|length) (?:is )?exceeded|input token count.{0,40}exceeds the maximum|exceeded model token limit|exceeds the available context size|input is too long for requested model/i;
const NOT_OVERFLOW_STATUSES = new Set([401, 402, 403, 404, 429]);

type Sized = { id: string; facts?: ModelFacts };

export function contextWindow(dep: Sized): number {
  return dep.facts?.contextLength ?? 0;
}

export function largestWindow(deps: Sized[]): number {
  return deps.reduce((largest, dep) => Math.max(largest, contextWindow(dep)), 0);
}

export function contextOverflow(err: unknown): boolean {
  if (!(err instanceof GateError) || err.requestScoped || NOT_OVERFLOW_STATUSES.has(err.status)) return false;
  return OVERFLOW_CODES.has(err.code) || OVERFLOW_MESSAGE.test(err.message);
}

export class ContextFit {
  private demand: ContextDemand | null = null;
  private floor = 0;
  private largest = 0;

  constructor(
    private readonly measure: () => ContextDemand,
    private readonly subject: LogMeta = {},
  ) {}

  need(): ContextDemand {
    this.demand ??= this.measure();
    return { input: Math.max(this.demand.input, this.floor), output: this.demand.output };
  }

  fits(dep: Sized, relaxed: boolean): boolean {
    const window = contextWindow(dep);
    if (window <= 0) return true;
    const { input, output } = this.need();
    return window >= (relaxed ? input : input + output);
  }

  plan(candidates: Sized[], relaxed: boolean): ContextPlan {
    if (!candidates.some((dep) => contextWindow(dep) > 0)) return "open";
    const fitting = candidates.filter((dep) => this.fits(dep, relaxed)).length;
    if (fitting === candidates.length) return "open";
    if (fitting > 0) return "narrowed";
    if (!relaxed && candidates.some((dep) => this.fits(dep, true))) return "tight";
    this.largest = Math.max(this.largest, largestWindow(candidates));
    return "short";
  }

  overflowed(dep: Sized): void {
    const window = contextWindow(dep);
    if (window > 0) this.floor = Math.max(this.floor, window + 1);
  }

  get short(): boolean {
    return this.largest > 0;
  }

  rejection(model: string): GateError {
    const { input, output } = this.need();
    const requested = output > 0 ? `, plus ${output} requested output tokens` : "";
    return new GateError(
      400,
      "context_length_exceeded",
      `prompt is too long: ${input} tokens > ${this.largest} maximum (gateway estimate${requested}; no deployment of ${model} or its fallbacks has a larger context window)`,
      { param: "messages", requestScoped: true },
    );
  }

  record(decision: ContextDecision, alias: string, routes: Sized[]): void {
    const { input, output } = this.need();
    logger.info("gateway.context_route", {
      ...this.subject,
      decision,
      alias,
      input,
      output,
      window: decision === "rejected" ? this.largest : largestWindow(routes),
      ...(decision === "overflow" ? { deployment: routes[0]?.id ?? "" } : {}),
    });
  }
}
