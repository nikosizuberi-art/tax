import { Decimal } from "./money";
import type { BandRow } from "./brackets";

/**
 * A single line of the calculation. The user-facing explanation is rendered from
 * these objects, never written as separate prose, so the words and the number
 * cannot drift apart.
 */
export interface TraceStep {
  id: string;
  label: string;
  /** Human-readable formula, e.g. "brackets(48.200) - brackets(5.550)". */
  formula: string;
  inputs: Record<string, Decimal>;
  output: Decimal;
  legalRef?: string;
  note?: string;
  /** Present on bracket steps so the UI can expand every band. */
  bands?: BandRow[];
  /** "eur" | "cad" | "percent" | "count" - how the UI should format the output. */
  unit?: "money" | "percent" | "count";
}

export class Trace {
  readonly steps: TraceStep[] = [];

  /** Append a step and return its output, so pipelines read as straight-line code. */
  add(step: TraceStep): Decimal {
    this.steps.push(step);
    return step.output;
  }

  get(id: string): TraceStep | undefined {
    return this.steps.find((s) => s.id === id);
  }

  value(id: string): Decimal {
    const step = this.get(id);
    if (!step) throw new Error(`Trace step not found: ${id}`);
    return step.output;
  }
}

/** Serialisable form for crossing a React state boundary or a JSON export. */
export interface SerialisedStep {
  id: string;
  label: string;
  formula: string;
  inputs: Record<string, string>;
  output: string;
  legalRef?: string;
  note?: string;
  unit?: "money" | "percent" | "count";
  bands?: Array<{ from: string; to: string | null; rate: string; taxableInBand: string; tax: string }>;
}

export function serialiseTrace(trace: Trace): SerialisedStep[] {
  return trace.steps.map((s) => ({
    id: s.id,
    label: s.label,
    formula: s.formula,
    inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, v.toString()])),
    output: s.output.toString(),
    legalRef: s.legalRef,
    note: s.note,
    unit: s.unit,
    bands: s.bands?.map((b) => ({
      from: b.from.toString(),
      to: b.to === null ? null : b.to.toString(),
      rate: b.rate.toString(),
      taxableInBand: b.taxableInBand.toString(),
      tax: b.tax.toString(),
    })),
  }));
}
