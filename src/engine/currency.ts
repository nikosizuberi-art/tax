/**
 * Currency is not cosmetic. The Kuwaiti dinar has three decimal places, the
 * Indian rupee is customarily shown with no decimals on a tax computation, and
 * Hong Kong rounds tax down to whole dollars. Formatting and the number of
 * decimal places a pipeline rounds to are separate decisions, so this table
 * carries the display rule and each ruleset carries its own rounding rule.
 */
export interface CurrencySpec {
  code: string;
  locale: string;
  /** Decimal places used when displaying an amount. */
  dp: number;
  /** Short symbol used as an input adornment. */
  symbol: string;
}

export const CURRENCIES: Record<string, CurrencySpec> = {
  EUR: { code: "EUR", locale: "de-DE", dp: 2, symbol: "€" },
  CAD: { code: "CAD", locale: "en-CA", dp: 2, symbol: "$" },
  HKD: { code: "HKD", locale: "en-HK", dp: 2, symbol: "HK$" },
  KWD: { code: "KWD", locale: "en-KW", dp: 3, symbol: "KD" },
  GBP: { code: "GBP", locale: "en-GB", dp: 2, symbol: "£" },
  PLN: { code: "PLN", locale: "pl-PL", dp: 2, symbol: "zł" },
  SGD: { code: "SGD", locale: "en-SG", dp: 2, symbol: "S$" },
  INR: { code: "INR", locale: "en-IN", dp: 2, symbol: "₹" },
  AUD: { code: "AUD", locale: "en-AU", dp: 2, symbol: "A$" },
};

/** Spain formats euro amounts differently from Germany and the Netherlands. */
export const LOCALE_OVERRIDES: Record<string, string> = {
  ES: "es-ES",
  DE: "de-DE",
  NL: "nl-NL",
  BG: "bg-BG",
};

export function currencySpec(code: string): CurrencySpec {
  const spec = CURRENCIES[code];
  if (!spec) throw new Error(`Unknown currency: ${code}`);
  return spec;
}
