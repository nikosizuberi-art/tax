import Decimal from "decimal.js";
import { currencySpec } from "./currency";

/**
 * All money in this engine is a Decimal. Floats are never used for money.
 * Precision is set well above anything a tax computation needs so that
 * intermediate results are exact; rounding only ever happens where a
 * pipeline step explicitly asks for it.
 */
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});

export { Decimal };

export type RoundingMode = "half-up" | "half-even" | "down" | "up";

/** Rounding is an explicit parameter of every step. There is no implicit Math.round anywhere. */
export interface Rounding {
  dp: number;
  mode: RoundingMode;
}

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  "half-up": Decimal.ROUND_HALF_UP,
  "half-even": Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

export const ZERO = new Decimal(0);

export function d(value: Decimal.Value | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  return new Decimal(value);
}

/** Round with an explicitly supplied rule. */
export function round(value: Decimal, rounding: Rounding): Decimal {
  return value.toDecimalPlaces(rounding.dp, MODES[rounding.mode]);
}

export function max(a: Decimal, b: Decimal): Decimal {
  return a.gte(b) ? a : b;
}

export function min(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

/** Clamp at zero. Tax lines are floored at zero in both jurisdictions. */
export function floorZero(value: Decimal): Decimal {
  return value.isNegative() ? ZERO : value;
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}

export type Currency = string;

/**
 * Money formatting is driven by the currency table, so a three-decimal currency
 * such as the Kuwaiti dinar renders correctly without special-casing at each
 * call site. `locale` overrides the currency default where two countries share
 * a currency but not a convention (Spain and Germany both use the euro).
 */
export function formatMoney(value: Decimal, currency: Currency, locale?: string): string {
  const spec = currencySpec(currency);
  return new Intl.NumberFormat(locale ?? spec.locale, {
    style: "currency",
    currency: spec.code,
    minimumFractionDigits: spec.dp,
    maximumFractionDigits: spec.dp,
  }).format(value.toNumber());
}

/** Percentages are shown to two decimals by default in every product surface. */
export function formatPercent(rate: Decimal, dp = 2): string {
  return `${rate.times(100).toFixed(dp)}%`;
}

/** Plain grouped number, used inside formula strings where a currency symbol would be noise. */
export function formatPlain(value: Decimal, currency: Currency, locale?: string): string {
  const spec = currencySpec(currency);
  return new Intl.NumberFormat(locale ?? spec.locale, {
    minimumFractionDigits: spec.dp,
    maximumFractionDigits: spec.dp,
  }).format(value.toNumber());
}
