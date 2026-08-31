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
import nl2026 from "../../rules/nl/2026/national.json";

registerGeneric("NL", 2026, nl2026);

interface NlSegment {
  upTo: string | null;
  base: string;
  from: string;
  rate: string;
  sign: "+" | "-";
}

interface NlRules extends GenericRuleset {
  box1Scale: ScaleSpec & { nationalInsurancePortion: string };
  algemeneHeffingskorting: {
    legalRef: string;
    maximum: string;
    taperStart: string;
    taperRate: string;
    zeroAt: string;
    note: string;
  };
  arbeidskorting: { legalRef: string; note: string; segments: NlSegment[] };
  donations: { legalRef: string; thresholdPercent: string; capPercent: string; note: string };
}

const LOCALE = "nl-NL";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(3).replace(".", ",").replace(/,?0+$/, "")}%`;

/** The arbeidskorting is a four-segment piecewise function of labour income. */
function arbeidskorting(income: Decimal, segments: NlSegment[]): { amount: Decimal; formula: string } {
  for (const s of segments) {
    if (s.upTo === null || income.lte(d(s.upTo))) {
      const delta = d(s.rate).times(income.minus(d(s.from)));
      const amount = s.sign === "+" ? d(s.base).plus(delta) : d(s.base).minus(delta);
      return {
        amount: floorZero(amount),
        formula:
          s.upTo === null
            ? "0 - fully withdrawn above the final segment"
            : `${f(d(s.base))} ${s.sign} ${pct(d(s.rate))} x (${f(income)} - ${f(d(s.from))})`,
      };
    }
  }
  return { amount: ZERO, formula: "0" };
}

/**
 * The Dutch pipeline. Two credits, not allowances, and both of them taper - the
 * general credit from EUR 29,736 and the labour credit from EUR 45,592. Between
 * those points the headline bracket rate of 37.56% understates the true
 * marginal rate by more than ten points, which no bracket table reveals.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<NlRules>("NL", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Gross pay ------------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "nl-1",
    label: "Bruto inkomen uit werk (Box 1 gross)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. Deductions ------------------------------------------------------------ */
  const pension = readAnnual(v, "pensionPremium");
  const don = rules.donations;
  const donationsGiven = readAnnual(v, "donations");
  const donationThreshold = round(gross.times(d(don.thresholdPercent)), R);
  const donationCap = round(gross.times(d(don.capPercent)), R);
  const donationsAllowed = min(floorZero(donationsGiven.minus(donationThreshold)), donationCap);

  const deductions = trace.add({
    id: "nl-2",
    label: "Aftrekposten (deductions)",
    formula: `${f(pension)} (lijfrente) + ${f(donationsAllowed)} (gifts above the 1% threshold of ${f(donationThreshold)}, capped at ${f(donationCap)})`,
    inputs: {
      lijfrente: pension,
      "gifts claimed": donationsGiven,
      "1% threshold": donationThreshold,
      "10% cap": donationCap,
      "gifts allowed": donationsAllowed,
    },
    output: round(pension.plus(donationsAllowed), R),
    legalRef: don.legalRef,
    note: don.note,
    unit: "money",
  });

  const taxable = trace.add({
    id: "nl-3",
    label: "Belastbaar inkomen uit werk (Box 1 taxable income)",
    formula: `${f(gross)} - ${f(deductions)}`,
    inputs: { gross, deductions },
    output: floorZero(round(gross.minus(deductions), R)),
    unit: "money",
  });

  /* 3. Tax before credits ---------------------------------------------------- */
  const scale = evaluateScale(taxable, rules.box1Scale, R);
  const beforeCredits = trace.add({
    id: "nl-4",
    label: "Box 1 tax and national insurance before credits",
    formula: `box1(${f(taxable)})`,
    inputs: { "taxable income": taxable },
    output: scale.total,
    legalRef: rules.box1Scale.legalRef,
    note: rules.box1Scale.note,
    bands: scale.rows,
    unit: "money",
  });

  const niPortion = round(
    min(taxable, d(rules.box1Scale.bands[0].upTo!)).times(d(rules.box1Scale.nationalInsurancePortion)),
    R,
  );
  trace.add({
    id: "nl-4b",
    label: "Of which national insurance premiums",
    formula: `${pct(d(rules.box1Scale.nationalInsurancePortion))} x min(${f(taxable)}, ${f(d(rules.box1Scale.bands[0].upTo!))})`,
    inputs: { "national insurance portion": niPortion, "total before credits": beforeCredits },
    output: niPortion,
    note: "Shown for information only. It is already included in the figure above and is not charged separately.",
    unit: "money",
  });

  /* 4. Algemene heffingskorting ---------------------------------------------- */
  const ahk = rules.algemeneHeffingskorting;
  const ahkExcess = floorZero(taxable.minus(d(ahk.taperStart)));
  const ahkAmount = floorZero(
    round(d(ahk.maximum).minus(ahkExcess.times(d(ahk.taperRate))), R),
  );
  const general = trace.add({
    id: "nl-5",
    label: "Algemene heffingskorting",
    formula: ahkExcess.gt(0)
      ? `${f(d(ahk.maximum))} - ${pct(d(ahk.taperRate))} x (${f(taxable)} - ${f(d(ahk.taperStart))})`
      : `${f(d(ahk.maximum))} (full credit)`,
    inputs: {
      maximum: d(ahk.maximum),
      "taper start": d(ahk.taperStart),
      "taper rate": d(ahk.taperRate),
    },
    output: ahkAmount,
    legalRef: ahk.legalRef,
    note: ahk.note,
    unit: "money",
  });

  /* 5. Arbeidskorting --------------------------------------------------------- */
  const ak = arbeidskorting(gross, rules.arbeidskorting.segments);
  const labour = trace.add({
    id: "nl-6",
    label: "Arbeidskorting",
    formula: ak.formula,
    inputs: { "labour income": gross },
    output: round(ak.amount, R),
    legalRef: rules.arbeidskorting.legalRef,
    note: rules.arbeidskorting.note,
    unit: "money",
  });

  /* 6. Tax after credits ------------------------------------------------------ */
  const tax = trace.add({
    id: "nl-7",
    label: "Te betalen (tax after credits)",
    formula: `max(0, ${f(beforeCredits)} - ${f(general)} - ${f(labour)})`,
    inputs: {
      "before credits": beforeCredits,
      algemene_heffingskorting: general,
      arbeidskorting: labour,
    },
    output: floorZero(round(beforeCredits.minus(general).minus(labour), R)),
    note: "Credits reduce the tax, never below zero. Unused credit is not refunded to an employee.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "nl-8",
    label: "Teruggave of te betalen",
    formula: `${f(withheld)} (loonheffing withheld) - ${f(tax)} (due)`,
    inputs: { withheld, due: tax },
    output: round(withheld.minus(tax), R),
    unit: "money",
  });

  if (
    taxable.gt(d(ahk.taperStart)) &&
    ahkAmount.gt(0) &&
    gross.gt(d(rules.arbeidskorting.segments[2].upTo!))
  ) {
    warnings.push(
      "Both credits are being withdrawn at this income, so your true marginal rate is roughly twelve points above the headline bracket rate of 37.56%.",
    );
  }

  return { trace, grossAssessed: gross, social: ZERO, incomeTax: tax, withheld, months, warnings };
}

export const nlAdapter: CountryAdapter = {
  country: "NL",
  currency: "EUR",
  locale: LOCALE,
  label: "Netherlands",
  contributionLabel: "National insurance",
  contributionNote:
    "Charged inside the Box 1 bracket rate rather than separately, so it is counted within the tax figure.",
  regionLabel: "Jurisdiction",
  regionNote:
    "Dutch income tax has no provincial or municipal component, so there is only one option.",

  years: () => genericYears("NL"),
  regions: (year) => genericRegions("NL", year),

  fields(year): FieldSpec[] {
    return loadGeneric<NlRules>("NL", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<NlRules>("NL", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "NL",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("nl", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "National insurance premiums are inside the bracket rate here rather than charged separately, so this single figure already covers them.",
    });
  },
};
