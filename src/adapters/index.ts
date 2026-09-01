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
import { usAdapter } from "./us";
import { frAdapter } from "./fr";
import { itAdapter } from "./it";
import { ieAdapter } from "./ie";
import { ptAdapter } from "./pt";
import { atAdapter } from "./at";
import { czAdapter } from "./cz";
import { dkAdapter } from "./dk";
import { noAdapter } from "./no";
import { jpAdapter } from "./jp";
import { cnAdapter } from "./cn";
import { krAdapter } from "./kr";
import { nzAdapter } from "./nz";
import { brAdapter } from "./br";
import { mxAdapter } from "./mx";
import { zaAdapter } from "./za";
import { trAdapter } from "./tr";
import { saAdapter } from "./sa";
import type { CalcInput, CalcResult, CountryAdapter, CountryCode } from "../engine/types";

/**
 * Each country owns its own pipeline. There is deliberately no shared
 * "apply allowance then run brackets" path, because these thirty jurisdictions
 * genuinely differ in shape:
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
 *   USA          runs a second, independent state computation on its own base
 *   France       divides by family parts, taxes, multiplies back, then caps it
 *   Italy        withdraws an employment credit and adds two local surcharges
 *   Ireland      runs three separate charges over three different bases
 *   Portugal     applies a rate to the whole income and subtracts a fixed sum
 *   Austria      taxes the 13th and 14th salary at a flat 6%, apart from the rest
 *   Czechia      taxes GROSS pay: contributions are not deductible at all
 *   Denmark      takes 8% off the top first, then splits into two bases
 *   Norway       taxes one base at 22% and a different base in five steps
 *   Japan        deducts a formula that stops growing, then adds two more taxes
 *   China        deducts a flat sum and applies a rate with a quick deduction
 *   Korea        deducts a sharply regressive formula, then adds 10% of the tax
 *   New Zealand  has no allowance at all, and a credit that exists in a window
 *   Brazil       is genuinely twelve monthly computations, not one annual one
 *   Mexico       applies a fixed quota plus a rate on the excess
 *   South Africa taxes from the first rand and rebates the tax afterwards
 *   Turkiye      exempts the tax attributable to the minimum wage, for everyone
 *   Saudi Arabia has no personal income tax
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
  US: usAdapter,
  FR: frAdapter,
  IT: itAdapter,
  IE: ieAdapter,
  PT: ptAdapter,
  AT: atAdapter,
  CZ: czAdapter,
  DK: dkAdapter,
  NO: noAdapter,
  JP: jpAdapter,
  CN: cnAdapter,
  KR: krAdapter,
  NZ: nzAdapter,
  BR: brAdapter,
  MX: mxAdapter,
  ZA: zaAdapter,
  TR: trAdapter,
  SA: saAdapter,
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
