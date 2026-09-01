import {
  Decimal,
  d,
  ZERO,
  min,
  sum,
  floorZero,
  round,
  formatPlain,
  type Rounding,
} from "../engine/money";
import { Trace } from "../engine/trace";
import {
  loadGeneric,
  genericRegion,
  genericRegions,
  genericYears,
  registerGeneric,
  stamp,
  type GenericRuleset,
  type GenericRegion,
} from "../engine/registry";
import { readMonthly, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import no2026 from "../../rules/no/2026/national.json";

registerGeneric("NO", 2026, no2026);

interface NoRules extends GenericRuleset {
  generalIncome: { legalRef: string; rate: string; note: string };
  minstefradrag: { legalRef: string; rate: string; maximum: string; note: string };
  personfradrag: { legalRef: string; amount: string; note: string };
  trinnskatt: {
    legalRef: string;
    note: string;
    tiers: Array<{ threshold: string; rate: string }>;
  };
  trygdeavgift: { legalRef: string; rate: string; note: string };
}

const LOCALE = "nb-NO";
const f = (v: Decimal) => formatPlain(v, "NOK", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Norway's pipeline runs TWO taxes over two different bases at once. The 22%
 * tax on alminnelig inntekt is charged after the minimum standard deduction and
 * the personal allowance. The bracket tax is charged on GROSS personal income
 * with neither of them. A deduction therefore reduces one tax and not the
 * other, and the real marginal rate is the sum of a rate on a reduced base and
 * a rate on the full one.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<NoRules>("NO", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "no-1",
    label: "Personinntekt (bruttolonn)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    note: "This is the base for both the bracket tax and national insurance, with no deductions at all.",
    unit: "money",
  });

  /* Trygdeavgift ------------------------------------------------------------------ */
  const trygde = trace.add({
    id: "no-2",
    label: "Trygdeavgift",
    formula: `${pct(d(rules.trygdeavgift.rate))} x ${f(gross)}`,
    inputs: { sats: d(rules.trygdeavgift.rate) },
    output: round(gross.times(d(rules.trygdeavgift.rate)), R),
    legalRef: rules.trygdeavgift.legalRef,
    note: rules.trygdeavgift.note,
    unit: "money",
  });

  /* Minstefradrag and alminnelig inntekt -------------------------------------------- */
  const mf = rules.minstefradrag;
  const minstefradrag = min(round(gross.times(d(mf.rate)), R), d(mf.maximum));
  trace.add({
    id: "no-3",
    label: "Minstefradrag",
    formula: `min(${pct(d(mf.rate))} x ${f(gross)}, ${f(d(mf.maximum))})`,
    inputs: { sats: d(mf.rate), "ovre grense": d(mf.maximum) },
    output: minstefradrag,
    legalRef: mf.legalRef,
    note: mf.note,
    unit: "money",
  });

  const personfradrag = d(rules.personfradrag.amount);
  const generalBase = trace.add({
    id: "no-4",
    label: "Alminnelig inntekt etter personfradrag",
    formula: `${f(gross)} - ${f(minstefradrag)} (minstefradrag) - ${f(personfradrag)} (personfradrag)`,
    inputs: { personinntekt: gross, minstefradrag, personfradrag },
    output: floorZero(round(gross.minus(minstefradrag).minus(personfradrag), R)),
    legalRef: rules.personfradrag.legalRef,
    unit: "money",
  });

  const flatTax = trace.add({
    id: "no-5",
    label: "Skatt paa alminnelig inntekt",
    formula: `${pct(d(rules.generalIncome.rate))} x ${f(generalBase)}`,
    inputs: { grunnlag: generalBase, sats: d(rules.generalIncome.rate) },
    output: round(generalBase.times(d(rules.generalIncome.rate)), R),
    legalRef: rules.generalIncome.legalRef,
    note: rules.generalIncome.note,
    unit: "money",
  });

  /* Trinnskatt, on gross personal income -------------------------------------------- */
  const tiers = rules.trinnskatt.tiers;
  const tierAmounts = tiers.map((t, i) => {
    const upper = i + 1 < tiers.length ? d(tiers[i + 1].threshold) : null;
    const capped = upper === null ? gross : min(gross, upper);
    return round(floorZero(capped.minus(d(t.threshold))).times(d(t.rate)), R);
  });

  const trinnskatt = trace.add({
    id: "no-6",
    label: "Trinnskatt",
    formula: tiers
      .map((t, i) => `${pct(d(t.rate))} over ${f(d(t.threshold))} = ${f(tierAmounts[i])}`)
      .join("; "),
    inputs: Object.fromEntries(tiers.map((t, i) => [`trinn ${i + 1}`, d(t.threshold)])),
    output: round(sum(tierAmounts), R),
    legalRef: rules.trinnskatt.legalRef,
    note: rules.trinnskatt.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "no-7",
    label: "Samlet inntektsskatt",
    formula: `${f(flatTax)} (22% av alminnelig inntekt) + ${f(trinnskatt)} (trinnskatt)`,
    inputs: { "skatt paa alminnelig inntekt": flatTax, trinnskatt },
    output: round(flatTax.plus(trinnskatt), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "no-8",
    label: "Til gode eller restskatt",
    formula: `${f(withheld)} (forskuddstrekk) - ${f(totalTax)}`,
    inputs: { forskuddstrekk: withheld, skatt: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (gross.gt(d(mf.maximum).dividedBy(d(mf.rate)))) {
    warnings.push(
      "Your minstefradrag has reached its ceiling, so further pay no longer increases the deduction and your effective rate climbs.",
    );
  }

  return { trace, grossAssessed: gross, social: trygde, incomeTax: totalTax, withheld, months, warnings };
}

export const noAdapter: CountryAdapter = {
  country: "NO",
  currency: "NOK",
  locale: LOCALE,
  label: "Norway",
  contributionLabel: "Trygdeavgift",
  regionLabel: "Jurisdiction",
  regionNote:
    "Municipal and county tax are collected inside the 22% rate on general income, so there is no separate regional choice. Northern Norway has a special deduction that this version does not model.",

  years: () => genericYears("NO"),
  regions: (year) => genericRegions("NO", year),

  fields(year): FieldSpec[] {
    return loadGeneric<NoRules>("NO", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<NoRules>("NO", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "NO",
      currency: "NOK",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("no", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Below the minstefradrag ceiling an extra krone only raises the 22% base by 54 oere, but it raises the bracket tax base by the full krone.",
    });
  },
};
