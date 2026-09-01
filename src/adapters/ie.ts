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
import { evaluateScale, type ScaleSpec } from "../engine/brackets";
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
import { readMonthly, readAnnual, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import ie2026 from "../../rules/ie/2026/national.json";

registerGeneric("IE", 2026, ie2026);

interface IeRules extends GenericRuleset {
  incomeTax: {
    legalRef: string;
    standardRateBand: string;
    standardRate: string;
    higherRate: string;
    note: string;
  };
  credits: { legalRef: string; personal: string; employee: string; note: string };
  usc: ScaleSpec & { exemptionThreshold: string };
  prsi: { legalRef: string; note: string; monthlyRates: Array<{ months: number[]; rate: string }> };
}

const LOCALE = "en-IE";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * Ireland's pipeline runs THREE separate charges over the same pay, each with
 * its own base:
 *
 *   - income tax, at 20% then 40%, reduced by credits rather than allowances;
 *   - USC, with its own four bands, charged on gross pay BEFORE pension relief,
 *     and with a cliff: under EUR 13,000 no USC at all, over it the whole
 *     income is charged, not just the excess;
 *   - PRSI, at a flat rate that changes part-way through 2026.
 *
 * A pension contribution reduces the first and neither of the others.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<IeRules>("IE", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Gross pay -------------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "ie-1",
    label: "Gross pay for the year",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. PRSI, at a rate that changes on 1 October ------------------------------ */
  const rateForMonth = (i: number): Decimal => {
    const entry = rules.prsi.monthlyRates.find((r) => r.months.includes(i + 1));
    if (!entry) throw new Error(`No PRSI rate defined for month ${i + 1}`);
    return d(entry.rate);
  };
  const monthlyPrsi = monthlyGross.map((g, i) => round(g.times(rateForMonth(i)), R));
  const prsi = trace.add({
    id: "ie-2",
    label: "PRSI (Class A employee)",
    formula: `${pct(d(rules.prsi.monthlyRates[0].rate))} on pay to September, ${pct(d(rules.prsi.monthlyRates[1].rate))} from October`,
    inputs: {
      "rate to 30 September": d(rules.prsi.monthlyRates[0].rate),
      "rate from 1 October": d(rules.prsi.monthlyRates[1].rate),
    },
    output: round(sum(monthlyPrsi), R),
    legalRef: rules.prsi.legalRef,
    note: rules.prsi.note,
    unit: "money",
  });

  /* 3. USC, on gross pay before pension relief -------------------------------- */
  const uscExempt = gross.lte(d(rules.usc.exemptionThreshold));
  const uscScale = evaluateScale(gross, rules.usc, R);
  const usc = trace.add({
    id: "ie-3",
    label: "Universal Social Charge",
    formula: uscExempt
      ? `0 - income of ${f(gross)} is within the ${f(d(rules.usc.exemptionThreshold))} exemption`
      : `usc_bands(${f(gross)})`,
    inputs: { "gross income": gross, "exemption threshold": d(rules.usc.exemptionThreshold) },
    output: uscExempt ? ZERO : uscScale.total,
    legalRef: rules.usc.legalRef,
    note: rules.usc.note,
    bands: uscExempt ? undefined : uscScale.rows,
    unit: "money",
  });

  /* 4. Income tax ------------------------------------------------------------- */
  const pension = min(readAnnual(v, "pension"), gross);
  const taxable = trace.add({
    id: "ie-4",
    label: "Income for income tax",
    formula: `${f(gross)} - ${f(pension)} (pension relief)`,
    inputs: { gross, pension },
    output: floorZero(round(gross.minus(pension), R)),
    note: "Pension relief applies to income tax only. USC and PRSI above were charged on the full gross.",
    unit: "money",
  });

  const band = d(rules.incomeTax.standardRateBand);
  const atStandard = min(taxable, band);
  const atHigher = floorZero(taxable.minus(band));
  const grossTax = round(
    atStandard.times(d(rules.incomeTax.standardRate)).plus(atHigher.times(d(rules.incomeTax.higherRate))),
    R,
  );

  const taxBeforeCredits = trace.add({
    id: "ie-5",
    label: "Income tax before credits",
    formula: `${pct(d(rules.incomeTax.standardRate))} x ${f(atStandard)} + ${pct(d(rules.incomeTax.higherRate))} x ${f(atHigher)}`,
    inputs: { "at the standard rate": atStandard, "at the higher rate": atHigher },
    output: grossTax,
    legalRef: rules.incomeTax.legalRef,
    note: rules.incomeTax.note,
    unit: "money",
  });

  /* 5. Credits ---------------------------------------------------------------- */
  const creditsAvailable = d(rules.credits.personal).plus(d(rules.credits.employee));
  const creditsUsed = min(creditsAvailable, taxBeforeCredits);
  trace.add({
    id: "ie-6",
    label: "Tax credits",
    formula: `${f(d(rules.credits.personal))} (personal) + ${f(d(rules.credits.employee))} (employee), limited to the tax due`,
    inputs: { available: creditsAvailable, used: creditsUsed },
    output: creditsUsed,
    legalRef: rules.credits.legalRef,
    note: rules.credits.note,
    unit: "money",
  });

  const incomeTax = trace.add({
    id: "ie-7",
    label: "Income tax after credits",
    formula: `max(0, ${f(taxBeforeCredits)} - ${f(creditsUsed)})`,
    inputs: { "before credits": taxBeforeCredits, credits: creditsUsed },
    output: floorZero(round(taxBeforeCredits.minus(creditsUsed), R)),
    unit: "money",
  });

  const totalTax = trace.add({
    id: "ie-8",
    label: "Income tax and USC",
    formula: `${f(incomeTax)} (income tax) + ${f(usc)} (USC)`,
    inputs: { "income tax": incomeTax, USC: usc },
    output: round(incomeTax.plus(usc), R),
    note: "PRSI is shown separately as a contribution rather than as tax.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "ie-9",
    label: "Refund or underpayment",
    formula: `${f(withheld)} (PAYE deducted) - ${f(totalTax)}`,
    inputs: { withheld, due: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (gross.gt(d(rules.usc.exemptionThreshold)) && gross.lt(d(rules.usc.exemptionThreshold).times(1.1))) {
    warnings.push(
      "You are just over the USC exemption threshold. Crossing it charges USC on your whole income, not only on the amount above the threshold.",
    );
  }

  return { trace, grossAssessed: gross, social: prsi, incomeTax: totalTax, withheld, months, warnings };
}

export const ieAdapter: CountryAdapter = {
  country: "IE",
  currency: "EUR",
  locale: LOCALE,
  label: "Ireland",
  contributionLabel: "PRSI",
  regionLabel: "Jurisdiction",
  regionNote: "Irish income tax has no regional component, so there is one option here.",

  years: () => genericYears("IE"),
  regions: (year) => genericRegions("IE", year),

  fields(year): FieldSpec[] {
    return loadGeneric<IeRules>("IE", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<IeRules>("IE", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "IE",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("ie", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "The reported figure combines income tax and USC. At the USC exemption threshold it is briefly enormous, because the charge applies to the whole income once you cross it.",
    });
  },
};
