import type { Decimal, Currency } from "./money";
import type { SerialisedStep } from "./trace";

/**
 * Every country here has its own adapter and its own pipeline. Adding a code
 * to this union without adding an adapter is a compile error, which is the
 * intent: there is no generic fallback calculation.
 */
export type CountryCode =
  | "ES"
  | "CA"
  | "HK"
  | "KW"
  | "BG"
  | "DE"
  | "GB"
  | "NL"
  | "PL"
  | "SG"
  | "IN"
  | "AU"
  | "US"
  | "FR"
  | "IT"
  | "IE"
  | "PT"
  | "AT"
  | "CZ"
  | "DK"
  | "NO"
  | "JP"
  | "CN"
  | "KR"
  | "NZ"
  | "BR"
  | "MX"
  | "ZA"
  | "TR"
  | "SA";

export interface Provenance {
  source: string;
  sourceUrl: string;
  verifiedOn: string | null;
  confidence: "verified" | "cited-unverified" | "unverified-estimate";
  notes: string;
}

export interface RulesetStamp {
  id: string;
  version: string;
  provenance: Provenance;
  verificationTodo?: string[];
  omissions?: string[];
}

/** Field declarations live in the rulesets; the form is generated from them. */
export type FieldKind = "monthly-money" | "annual-money" | "int" | "bool" | "enum";

export interface FieldSpec {
  id: string;
  kind: FieldKind;
  group: "income" | "deductions" | "personal" | "regional";
  label: string;
  help?: string;
  optional?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
}

/** Twelve slots, January to December. A blank month is a month with no income. */
export type MonthlyValue = Array<string | null>;

export type FieldValue = string | number | boolean | MonthlyValue | null;

export interface CalcInput {
  country: CountryCode;
  year: number;
  regionCode: string;
  values: Record<string, FieldValue>;
}

export interface Summary {
  annualGross: Decimal;
  /** Employee social contributions: Seguridad Social, or CPP + EI. */
  socialContributions: Decimal;
  incomeTax: Decimal;
  /** Income tax plus employee social contributions. */
  totalDeductions: Decimal;
  takeHome: Decimal;
  monthlyTakeHome: Decimal;
  effectiveRateOnGross: Decimal;
  effectiveIncomeTaxRate: Decimal;
  marginalRate: Decimal;
  withheld: Decimal;
  /** Positive = refund due, negative = amount owing. */
  balance: Decimal;
  monthsWorked: number;
}

export interface CalcResult {
  country: CountryCode;
  year: number;
  regionCode: string;
  regionName: string;
  currency: Currency;
  summary: Summary;
  steps: SerialisedStep[];
  rulesets: RulesetStamp[];
  warnings: string[];
  computedAt: string;
}

export interface CountryAdapter {
  country: CountryCode;
  currency: Currency;
  label: string;
  /** What the region selector is called, e.g. "Comunidad autonoma", "Province". */
  regionLabel: string;
  /** Why a region must be chosen, or why this country has only one. */
  regionNote: string;
  /** Locale override where a shared currency is formatted differently. */
  locale?: string;
  /** What this country calls its compulsory employee contributions. */
  contributionLabel: string;
  /** Shown under the contributions figure where it needs explaining. */
  contributionNote?: string;
  /**
   * False where the country withholds nothing from an employee, so the result
   * block does not invite a comparison that cannot be made.
   */
  hasWithholding?: boolean;
  regions(year: number): Array<{ code: string; name: string }>;
  years(): number[];
  fields(year: number, regionCode: string): FieldSpec[];
  compute(input: CalcInput): CalcResult;
}
