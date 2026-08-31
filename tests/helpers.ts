import { Decimal } from "../src/engine/money";
import type { CalcInput, CountryCode, FieldValue } from "../src/engine/types";

/** Spread an annual amount evenly over the first `months` months. */
export function months(annual: number | string, monthCount = 12): Array<string | null> {
  const per = new Decimal(annual).dividedBy(monthCount);
  return Array.from({ length: 12 }, (_, i) => (i < monthCount ? per.toString() : null));
}

/** Twelve identical monthly amounts. */
export function perMonth(amount: number | string, monthCount = 12): Array<string | null> {
  return Array.from({ length: 12 }, (_, i) => (i < monthCount ? String(amount) : null));
}

export function input(
  country: CountryCode,
  regionCode: string,
  values: Record<string, FieldValue>,
  year = 2026,
): CalcInput {
  return { country, year, regionCode, values };
}

export function es(
  regionCode: string,
  values: Record<string, FieldValue>,
  year = 2026,
): CalcInput {
  return input("ES", regionCode, values, year);
}

export function ca(
  regionCode: string,
  values: Record<string, FieldValue>,
  year = 2026,
): CalcInput {
  return input("CA", regionCode, values, year);
}

export function num(v: Decimal): number {
  return v.toNumber();
}

/** Round to cents for comparison against hand-derived expectations. */
export function cents(v: Decimal): number {
  return Number(v.toDecimalPlaces(2).toString());
}
