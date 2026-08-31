import { Decimal, d, ZERO } from "./money";
import type { FieldValue, MonthlyValue } from "./types";

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function emptyMonths(): MonthlyValue {
  return Array.from({ length: 12 }, () => null);
}

/**
 * Read a 12-slot monthly field. A blank month is a month with no income; it is
 * never filled in by annualising the rest of the year.
 */
export function readMonthly(values: Record<string, FieldValue>, id: string): Decimal[] {
  const raw = values[id];
  const arr = Array.isArray(raw) ? raw : emptyMonths();
  return Array.from({ length: 12 }, (_, i) => {
    const v = arr[i];
    if (v === null || v === undefined || String(v).trim() === "") return ZERO;
    const parsed = new Decimal(String(v).replace(/\s/g, "").replace(",", "."));
    return parsed.isFinite() && parsed.gt(0) ? parsed : ZERO;
  });
}

export function monthsWorked(monthly: Decimal[]): number {
  return monthly.filter((m) => m.gt(0)).length;
}

export function readAnnual(values: Record<string, FieldValue>, id: string): Decimal {
  const v = values[id];
  if (v === null || v === undefined || v === "" || typeof v === "boolean" || Array.isArray(v)) {
    return ZERO;
  }
  const parsed = new Decimal(String(v).replace(/\s/g, "").replace(",", "."));
  return parsed.isFinite() && parsed.gt(0) ? parsed : ZERO;
}

export function readInt(values: Record<string, FieldValue>, id: string, fallback = 0): number {
  const v = values[id];
  if (v === null || v === undefined || v === "" || typeof v === "boolean" || Array.isArray(v)) {
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

export function readBool(values: Record<string, FieldValue>, id: string): boolean {
  return values[id] === true || values[id] === "true";
}

export function readEnum(values: Record<string, FieldValue>, id: string, fallback: string): string {
  const v = values[id];
  return typeof v === "string" && v !== "" ? v : fallback;
}

/** Add a probe amount to the first month that has income, or to January if none does. */
export function withProbe(monthly: Decimal[], probe: Decimal): Decimal[] {
  if (probe.isZero()) return monthly;
  const idx = monthly.findIndex((m) => m.gt(0));
  const target = idx === -1 ? 0 : idx;
  return monthly.map((m, i) => (i === target ? m.plus(probe) : m));
}

export { d, ZERO };
