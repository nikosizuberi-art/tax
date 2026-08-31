import { esAdapter } from "./es";
import { caAdapter } from "./ca";
import { hkAdapter } from "./hk";
import { kwAdapter } from "./kw";
import { bgAdapter } from "./bg";
import { deAdapter } from "./de";
import { gbAdapter } from "./gb";
import { nlAdapter } from "./nl";
import { plAdapter } from "./pl";
import { sgAdapter } from "./sg";
import { inAdapter } from "./in";
import { auAdapter } from "./au";
import type { CalcInput, CalcResult, CountryAdapter, CountryCode } from "../engine/types";

/**
 * Each country owns its own pipeline. There is deliberately no shared
 * "apply allowance then run brackets" path, because the twelve jurisdictions
 * here genuinely differ in shape:
 *
 *   Spain        applies the scales twice and subtracts the second result
 *   Canada       subtracts credits valued at the lowest bracket rate
 *   Hong Kong    computes the tax twice and charges the lower figure
 *   Kuwait       has no personal income tax at all
 *   Bulgaria     charges one flat rate on income after contributions
 *   Germany      evaluates a piecewise polynomial, not brackets
 *   UK           tapers the allowance away, creating a 60% band
 *   Netherlands  withdraws two separate credits on two separate schedules
 *   Poland       reduces the tax by a fixed amount and taxes a non-deductible
 *                health contribution alongside it
 *   Singapore    caps the SUM of all reliefs at one overall figure
 *   India        applies a rebate and a surcharge, each with marginal relief,
 *                then a cess on top of both
 *   Australia    shades in a levy and withdraws a non-refundable offset
 *
 * Collapsing any two of these into a shared bracket function would give the
 * wrong answer for both.
 */
export const adapters: Record<CountryCode, CountryAdapter> = {
  ES: esAdapter,
  CA: caAdapter,
  HK: hkAdapter,
  KW: kwAdapter,
  BG: bgAdapter,
  DE: deAdapter,
  GB: gbAdapter,
  NL: nlAdapter,
  PL: plAdapter,
  SG: sgAdapter,
  IN: inAdapter,
  AU: auAdapter,
};

export function getAdapter(country: CountryCode): CountryAdapter {
  return adapters[country];
}

export function compute(input: CalcInput): CalcResult {
  return getAdapter(input.country).compute(input);
}

/** Listed alphabetically by label, which is how the picker renders them. */
export const COUNTRIES: Array<{ code: CountryCode; label: string }> = (
  Object.keys(adapters) as CountryCode[]
)
  .map((code) => ({ code, label: adapters[code].label }))
  .sort((a, b) => a.label.localeCompare(b.label));
