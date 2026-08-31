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
import { readMonthly, readBool, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import pl2026 from "../../rules/pl/2026/national.json";

registerGeneric("PL", 2026, pl2026);

interface PlRules extends GenericRuleset {
  scale: {
    legalRef: string;
    note: string;
    firstThreshold: string;
    firstRate: string;
    secondRate: string;
    taxReducingAmount: string;
  };
  socialInsurance: {
    legalRef: string;
    pensionAndDisabilityRate: string;
    annualCap: string;
    sicknessRate: string;
    note: string;
  };
  healthInsurance: { legalRef: string; rate: string; deductible: boolean; note: string };
  deductibleCosts: {
    legalRef: string;
    standardMonthly: string;
    commuterMonthly: string;
    note: string;
  };
  youthRelief: { legalRef: string; ageLimit: number; exemptionLimit: string; note: string };
  solidarityLevy: { legalRef: string; threshold: string; rate: string; note: string };
  rounding: GenericRuleset["rounding"] & { taxBaseDp: number; finalTaxDp: number };
}

const LOCALE = "pl-PL";
const f = (v: Decimal) => formatPlain(v, "PLN", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Poland's pipeline. Three things make it its own shape:
 *
 *   - the tax-free amount is delivered as a PLN 3,600 reduction of the TAX,
 *     not as an allowance against income;
 *   - the 9% health contribution is not deductible from income or from tax,
 *     so it behaves as a second flat tax and belongs in the marginal rate;
 *   - the pension and disability cap is ANNUAL, so it bites part-way through
 *     the year rather than month by month.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<PlRules>("PL", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };
  const BASE: Rounding = { dp: rules.rounding.taxBaseDp, mode: "half-up" };
  const FINAL: Rounding = { dp: rules.rounding.finalTaxDp, mode: "half-up" };

  /* 1. Gross pay ------------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "pl-1",
    label: "Przychód brutto (annual gross)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. ZUS social contributions, the cap applied as the year runs ------------ */
  const si = rules.socialInsurance;
  const cap = d(si.annualCap);
  let cumulative = ZERO;
  const cappedBases = monthlyGross.map((g) => {
    const remaining = floorZero(cap.minus(cumulative));
    const base = min(g, remaining);
    cumulative = cumulative.plus(g);
    return base;
  });
  const pensionDisability = round(
    sum(cappedBases.map((b) => b.times(d(si.pensionAndDisabilityRate)))),
    R,
  );
  const sickness = round(gross.times(d(si.sicknessRate)), R);
  const socialTotal = round(pensionDisability.plus(sickness), R);

  trace.add({
    id: "pl-2",
    label: "Składki ZUS (social insurance)",
    formula: `${pct(d(si.pensionAndDisabilityRate))} on pay up to the annual cap of ${f(cap)} = ${f(pensionDisability)}, plus ${pct(d(si.sicknessRate))} uncapped = ${f(sickness)}`,
    inputs: {
      "pension and disability": pensionDisability,
      sickness,
      "annual cap": cap,
    },
    output: socialTotal,
    legalRef: si.legalRef,
    note: si.note,
    unit: "money",
  });

  /* 3. Health contribution - not deductible --------------------------------- */
  const hi = rules.healthInsurance;
  const healthBase = floorZero(gross.minus(socialTotal));
  const health = round(healthBase.times(d(hi.rate)), R);
  trace.add({
    id: "pl-3",
    label: "Składka zdrowotna (health contribution)",
    formula: `${pct(d(hi.rate))} x (${f(gross)} - ${f(socialTotal)})`,
    inputs: { "health base": healthBase, rate: d(hi.rate) },
    output: health,
    legalRef: hi.legalRef,
    note: hi.note,
    unit: "money",
  });

  /* 4. Deductible costs ------------------------------------------------------ */
  const yr = rules.youthRelief;
  const under26 = readBool(v, "under26");
  const exempt = under26 ? min(gross, d(yr.exemptionLimit)) : ZERO;
  trace.add({
    id: "pl-4",
    label: "Ulga dla młodych (under-26 exemption)",
    formula: under26
      ? `min(${f(gross)}, ${f(d(yr.exemptionLimit))})`
      : "0 - the under-26 exemption was not claimed",
    inputs: { "exemption limit": d(yr.exemptionLimit) },
    output: exempt,
    legalRef: yr.legalRef,
    note: yr.note,
    unit: "money",
  });

  /* 5. Deductible costs and ZUS, both limited to the TAXABLE share ---------- */
  // Contributions and costs attributable to exempt income are not deductible,
  // so where the under-26 exemption applies both are apportioned to the part
  // of pay that remains taxable. Deducting them in full would understate the
  // tax of a young worker who earns past the exemption limit.
  const dc = rules.deductibleCosts;
  const commuter = readBool(v, "commuter");
  const monthlyCost = commuter ? d(dc.commuterMonthly) : d(dc.standardMonthly);
  const taxableShare = gross.isZero() ? ZERO : gross.minus(exempt).dividedBy(gross);
  const costs = round(monthlyCost.times(months).times(taxableShare), R);
  const zusDeductible = round(socialTotal.times(taxableShare), R);

  trace.add({
    id: "pl-5",
    label: "Koszty uzyskania przychodu (deductible costs)",
    formula: exempt.gt(0)
      ? `${f(monthlyCost)} x ${months} month(s) x ${taxableShare.times(100).toFixed(2)}% taxable share`
      : `${f(monthlyCost)} x ${months} month(s) with income`,
    inputs: { "monthly amount": monthlyCost, "taxable share": taxableShare },
    output: costs,
    legalRef: dc.legalRef,
    note: exempt.gt(0)
      ? "Apportioned: costs and contributions relating to exempt income are not deductible."
      : dc.note,
    unit: "money",
  });

  /* 6. Tax base --------------------------------------------------------------- */
  const base = trace.add({
    id: "pl-6",
    label: "Podstawa opodatkowania (tax base)",
    formula: `${f(gross)} - ${f(exempt)} (exempt) - ${f(zusDeductible)} (deductible ZUS) - ${f(costs)} (costs), rounded to whole zloty`,
    inputs: { gross, exempt, "ZUS deductible": zusDeductible, "ZUS paid": socialTotal, costs },
    output: round(floorZero(gross.minus(exempt).minus(zusDeductible).minus(costs)), BASE),
    note: "The health contribution is deliberately NOT subtracted here: since 2022 it is not deductible.",
    unit: "money",
  });

  /* 7. The scale, then the tax-reducing amount ------------------------------- */
  const threshold = d(rules.scale.firstThreshold);
  const firstRate = d(rules.scale.firstRate);
  const secondRate = d(rules.scale.secondRate);
  const gradual = base.lte(threshold)
    ? base.times(firstRate)
    : threshold.times(firstRate).plus(base.minus(threshold).times(secondRate));

  const beforeReduction = trace.add({
    id: "pl-7",
    label: "Podatek przed odliczeniem (tax before the reducing amount)",
    formula: base.lte(threshold)
      ? `${pct(firstRate)} x ${f(base)}`
      : `${pct(firstRate)} x ${f(threshold)} + ${pct(secondRate)} x (${f(base)} - ${f(threshold)})`,
    inputs: { "tax base": base, "first threshold": threshold },
    output: round(gradual, R),
    legalRef: rules.scale.legalRef,
    note: rules.scale.note,
    unit: "money",
  });

  const reducing = min(d(rules.scale.taxReducingAmount), beforeReduction);
  const tax = trace.add({
    id: "pl-8",
    label: "Kwota zmniejszająca podatek (tax-reducing amount)",
    formula: `max(0, ${f(beforeReduction)} - ${f(d(rules.scale.taxReducingAmount))})`,
    inputs: { "tax before reduction": beforeReduction, "reducing amount": reducing },
    output: round(floorZero(beforeReduction.minus(reducing)), FINAL),
    note: "This is what makes the first PLN 30,000 effectively tax free: 12% of 30,000 is exactly the 3,600 reduction.",
    unit: "money",
  });

  /* 8. Solidarity levy -------------------------------------------------------- */
  const sl = rules.solidarityLevy;
  const levyBase = floorZero(base.minus(d(sl.threshold)));
  const levy = round(levyBase.times(d(sl.rate)), FINAL);
  trace.add({
    id: "pl-9",
    label: "Danina solidarnościowa (solidarity levy)",
    formula: levyBase.gt(0)
      ? `${pct(d(sl.rate))} x (${f(base)} - ${f(d(sl.threshold))})`
      : `0 - income is below the ${f(d(sl.threshold))} threshold`,
    inputs: { "tax base": base, threshold: d(sl.threshold) },
    output: levy,
    legalRef: sl.legalRef,
    note: sl.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "pl-10",
    label: "Podatek łącznie (total tax)",
    formula: `${f(tax)} + ${f(levy)} (solidarity levy)`,
    inputs: { "income tax": tax, "solidarity levy": levy },
    output: round(tax.plus(levy), FINAL),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "pl-11",
    label: "Zwrot lub dopłata (refund or amount owing)",
    formula: `${f(withheld)} (advances withheld) - ${f(totalTax)} (tax due)`,
    inputs: { withheld, "tax due": totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (under26 && gross.gt(d(yr.exemptionLimit))) {
    warnings.push(
      `Your pay exceeds the under-26 exemption limit of ${f(d(yr.exemptionLimit))}, so the excess is taxed normally. Contributions are still due on the exempt part.`,
    );
  }
  if (cumulative.gt(cap)) {
    warnings.push(
      "You reached the annual pension and disability cap during the year, so your take-home pay rises for the remaining months even though your gross pay is unchanged.",
    );
  }

  return {
    trace,
    grossAssessed: gross,
    social: round(socialTotal.plus(health), R),
    incomeTax: totalTax,
    withheld,
    months,
    warnings,
  };
}

export const plAdapter: CountryAdapter = {
  country: "PL",
  currency: "PLN",
  locale: LOCALE,
  label: "Poland",
  contributionLabel: "ZUS and health contribution",
  contributionNote:
    "The 9% health contribution is included here because it is not deductible.",
  regionLabel: "Jurisdiction",
  regionNote: "Polish personal income tax has no regional component, so there is only one option.",

  years: () => genericYears("PL"),
  regions: (year) => genericRegions("PL", year),

  fields(year): FieldSpec[] {
    return loadGeneric<PlRules>("PL", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<PlRules>("PL", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "PL",
      currency: "PLN",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("pl", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "The 9% health contribution is not deductible, so it adds to the real burden on every extra zloty even though it does not appear in this income tax figure.",
    });
  },
};
