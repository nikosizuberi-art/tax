import {
  Decimal,
  d,
  ZERO,
  min,
  max,
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
import jp2026 from "../../rules/jp/2026/national.json";

registerGeneric("JP", 2026, jp2026);

interface JpTier {
  upTo: string | null;
  base: string;
  from: string;
  rate: string;
}

interface JpRules extends GenericRuleset {
  employmentIncomeDeduction: {
    legalRef: string;
    note: string;
    minimum: string;
    tiers: JpTier[];
  };
  basicDeduction: { legalRef: string; amount: string; note: string };
  nationalTax: {
    legalRef: string;
    note: string;
    bands: Array<{ upTo: string | null; rate: string; deduct: string }>;
  };
  reconstructionSurtax: { legalRef: string; rate: string; note: string };
  inhabitantsTax: { legalRef: string; rate: string; perCapita: string; note: string };
  socialInsurance: {
    legalRef: string;
    healthRate: string;
    pensionRate: string;
    employmentRate: string;
    note: string;
  };
}

const LOCALE = "ja-JP";
const f = (v: Decimal) => formatPlain(v, "JPY", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(3).replace(/\.?0+$/, "")}%`;

/**
 * Japan's pipeline. The employment income deduction is a piecewise formula that
 * stands in for expenses, and it FLATTENS above JPY 8,500,000 - so beyond that
 * point every extra yen is fully taxable and the effective rate climbs faster
 * than the bracket table alone implies.
 *
 * Two charges then sit on top of the national tax: a 2.1% reconstruction surtax
 * charged on the TAX, and a 10% inhabitant's tax charged on income and assessed
 * a year in arrears.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<JpRules>("JP", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "jp-1",
    label: "Gross employment income",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* Social insurance ---------------------------------------------------------------- */
  const si = rules.socialInsurance;
  const siRate = d(si.healthRate).plus(d(si.pensionRate)).plus(d(si.employmentRate));
  const social = trace.add({
    id: "jp-2",
    label: "Social insurance premiums",
    formula: `(${pct(d(si.healthRate))} health + ${pct(d(si.pensionRate))} pension + ${pct(d(si.employmentRate))} employment) x ${f(gross)}`,
    inputs: {
      health: d(si.healthRate),
      pension: d(si.pensionRate),
      employment: d(si.employmentRate),
      combined: siRate,
    },
    output: round(gross.times(siRate), R),
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* Employment income deduction ------------------------------------------------------ */
  const eid = rules.employmentIncomeDeduction;
  const tier =
    eid.tiers.find((t) => t.upTo === null || gross.lte(d(t.upTo))) ??
    eid.tiers[eid.tiers.length - 1];
  const computed = d(tier.base).plus(gross.minus(d(tier.from)).times(d(tier.rate)));
  const deduction = min(max(round(computed, R), min(d(eid.minimum), gross)), gross);

  trace.add({
    id: "jp-3",
    label: "Employment income deduction",
    formula: `${f(d(tier.base))} + ${pct(d(tier.rate))} x (${f(gross)} - ${f(d(tier.from))}), minimum ${f(d(eid.minimum))}`,
    inputs: { "gross income": gross, deduction },
    output: deduction,
    legalRef: eid.legalRef,
    note: eid.note,
    unit: "money",
  });

  /* Taxable income -------------------------------------------------------------------- */
  const basic = d(rules.basicDeduction.amount);
  const taxable = trace.add({
    id: "jp-4",
    label: "Taxable income",
    formula: `${f(gross)} - ${f(deduction)} (employment income deduction) - ${f(social)} (social insurance) - ${f(basic)} (basic deduction)`,
    inputs: {
      gross,
      "employment income deduction": deduction,
      "social insurance": social,
      "basic deduction": basic,
    },
    output: floorZero(round(gross.minus(deduction).minus(social).minus(basic), R)),
    legalRef: rules.basicDeduction.legalRef,
    note: rules.basicDeduction.note,
    unit: "money",
  });

  /* National income tax ---------------------------------------------------------------- */
  const band =
    rules.nationalTax.bands.find((b) => b.upTo === null || taxable.lte(d(b.upTo))) ??
    rules.nationalTax.bands[rules.nationalTax.bands.length - 1];
  const nationalTax = trace.add({
    id: "jp-5",
    label: "National income tax",
    formula: `${pct(d(band.rate))} x ${f(taxable)} - ${f(d(band.deduct))} (quick deduction)`,
    inputs: { "taxable income": taxable, rate: d(band.rate), "quick deduction": d(band.deduct) },
    output: floorZero(round(taxable.times(d(band.rate)).minus(d(band.deduct)), R)),
    legalRef: rules.nationalTax.legalRef,
    note: rules.nationalTax.note,
    unit: "money",
  });

  /* Reconstruction surtax --------------------------------------------------------------- */
  const surtax = trace.add({
    id: "jp-6",
    label: "Special reconstruction surtax",
    formula: `${pct(d(rules.reconstructionSurtax.rate))} x ${f(nationalTax)}`,
    inputs: { "national income tax": nationalTax },
    output: round(nationalTax.times(d(rules.reconstructionSurtax.rate)), R),
    legalRef: rules.reconstructionSurtax.legalRef,
    note: rules.reconstructionSurtax.note,
    unit: "money",
  });

  /* Inhabitant's tax ---------------------------------------------------------------------- */
  // The per capita charge is not levied on someone with no taxable income. The
  // real non-taxable threshold is higher than zero and varies by municipality;
  // this is the conservative approximation of it.
  const inhabitants = trace.add({
    id: "jp-7",
    label: "Local inhabitant's tax",
    formula: taxable.gt(0)
      ? `${pct(d(rules.inhabitantsTax.rate))} x ${f(taxable)} + ${f(d(rules.inhabitantsTax.perCapita))} per capita`
      : "0 - no taxable income, so neither the 10% charge nor the per capita levy applies",
    inputs: { "taxable income": taxable, "per capita": d(rules.inhabitantsTax.perCapita) },
    output: taxable.gt(0)
      ? round(
          taxable.times(d(rules.inhabitantsTax.rate)).plus(d(rules.inhabitantsTax.perCapita)),
          R,
        )
      : ZERO,
    legalRef: rules.inhabitantsTax.legalRef,
    note: rules.inhabitantsTax.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "jp-8",
    label: "Total tax",
    formula: `${f(nationalTax)} + ${f(surtax)} (surtax) + ${f(inhabitants)} (inhabitant's tax)`,
    inputs: { national: nationalTax, surtax, "inhabitant's tax": inhabitants },
    output: round(nationalTax.plus(surtax).plus(inhabitants), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "jp-9",
    label: "Year-end adjustment",
    formula: `${f(withheld)} (withheld) - ${f(totalTax)}`,
    inputs: { withheld, tax: totalTax },
    output: round(withheld.minus(totalTax), R),
    note: "Inhabitant's tax is assessed on the previous year's income and billed separately, so it is not part of the year-end adjustment in practice.",
    unit: "money",
  });

  warnings.push(
    "The 2026 income-dependent supplement to the basic deduction is not modelled, so this figure overstates the tax for many taxpayers.",
  );
  if (gross.gt(d("8500000"))) {
    warnings.push(
      "Your income is above JPY 8,500,000, where the employment income deduction stops growing. Every further yen is fully taxable.",
    );
  }

  return { trace, grossAssessed: gross, social, incomeTax: totalTax, withheld, months, warnings };
}

export const jpAdapter: CountryAdapter = {
  country: "JP",
  currency: "JPY",
  locale: LOCALE,
  label: "Japan",
  contributionLabel: "Social insurance",
  regionLabel: "Jurisdiction",
  regionNote:
    "Inhabitant's tax is 10% almost everywhere in Japan, so the prefecture is not offered as a choice here.",

  years: () => genericYears("JP"),
  regions: (year) => genericRegions("JP", year),

  fields(year): FieldSpec[] {
    return loadGeneric<JpRules>("JP", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<JpRules>("JP", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "JP",
      currency: "JPY",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("jp", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      probe: new Decimal(10000),
      marginalNote:
        "Measured over JPY 10,000 rather than 100, because the yen has no minor units.",
    });
  },
};
