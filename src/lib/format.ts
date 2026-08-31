import { Decimal, formatMoney, formatPercent } from "../engine/money";
import type { Currency } from "../engine/money";

export function money(value: Decimal | string, currency: Currency, locale?: string): string {
  return formatMoney(typeof value === "string" ? new Decimal(value) : value, currency, locale);
}

export function percent(value: Decimal | string, dp = 2): string {
  return formatPercent(typeof value === "string" ? new Decimal(value) : value, dp);
}

/** Trace steps carry strings; the unit tells us how to render them. */
export function stepValue(
  output: string,
  unit: "money" | "percent" | "count" | undefined,
  currency: Currency,
  locale?: string,
): string {
  if (unit === "percent") return percent(output);
  if (unit === "count") return output;
  return money(output, currency, locale);
}
