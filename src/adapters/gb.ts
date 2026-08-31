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
import { evaluateScale, type ScaleSpec, type BandSpec } from "../engine/brackets";
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
import gb2026 from "../../rules/gb/2026/national.json";

registerGeneric("GB", 2026, gb2026);

interface GbRegion extends GenericRegion {
  scale: ScaleSpec;
}

interface GbRules extends GenericRuleset {
  personalAllowance: {
    legalRef: string;
    amount: string;
    taperStart: string;
    taperRate: string;
    note: string;
  };
  nationalInsurance: {
    legalRef: string;
    monthlyPrimaryThreshold: string;
    monthlyUpperEarningsLimit: string;
    mainRate: string;
    upperRate: string;
    note: string;
  };
  giftAid: { legalRef: string; grossUpFactor: string; note: string };
}

const f = (v: Decimal) => formatPlain(v, "GBP");
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * The UK pipeline. Two features drive everything and neither is a bracket:
 *
 *   - the personal allowance is withdrawn at 50p per pound above GBP 100,000,
 *     so the 40% band hides a 60% sub-band that no rate table shows;
 *   - National Insurance is charged per PAY PERIOD and its rate FALLS from 8%
 *     to 2% above the upper earnings limit, so it is never reconciled annually
 *     and it moves in the opposite direction to income tax.
 *
 * Gift Aid does not reduce income; it extends the rate bands, which is a third
 * mechanism again.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<GbRules>("GB", input.year);
  const region = genericRegion<GbRegion>(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  /* 1. Gross pay ------------------------------------------------------------ */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "gb-1",
    label: "Gross pay for the year",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. National Insurance, charged per pay period ---------------------------- */
  const ni = rules.nationalInsurance;
  const pt = d(ni.monthlyPrimaryThreshold);
  const uel = d(ni.monthlyUpperEarningsLimit);
  const mainRate = d(ni.mainRate);
  const upperRate = d(ni.upperRate);

  const monthlyNi = monthlyGross.map((g) => {
    const main = floorZero(min(g, uel).minus(pt)).times(mainRate);
    const upper = floorZero(g.minus(uel)).times(upperRate);
    return round(main.plus(upper), R);
  });
  const monthsAboveUel = monthlyGross.filter((g) => g.gt(uel)).length;

  const national = trace.add({
    id: "gb-2",
    label: "National Insurance (Class 1 primary)",
    formula: `sum over 12 months of ${pct(mainRate)} x (min(pay, ${f(uel)}) - ${f(pt)}) + ${pct(upperRate)} x max(0, pay - ${f(uel)})`,
    inputs: {
      "monthly primary threshold": pt,
      "monthly upper earnings limit": uel,
      "main rate": mainRate,
      "rate above the upper limit": upperRate,
    },
    output: round(sum(monthlyNi), R),
    legalRef: ni.legalRef,
    note:
      monthsAboveUel > 0
        ? `${monthsAboveUel} month(s) exceeded the upper earnings limit, where the rate drops to 2%. Because NI is not reconciled annually, the same annual pay bunched into fewer months would cost more.`
        : ni.note,
    unit: "money",
  });

  /* 3. Pension and Gift Aid -------------------------------------------------- */
  const pension = min(readAnnual(v, "pension"), gross);
  const giftAidGiven = readAnnual(v, "giftAid");
  const giftAidGross = round(giftAidGiven.times(d(rules.giftAid.grossUpFactor)), R);

  trace.add({
    id: "gb-3",
    label: "Pension contributions and Gift Aid",
    formula: `${f(pension)} deducted from pay; Gift Aid of ${f(giftAidGiven)} grossed up to ${f(giftAidGross)}`,
    inputs: {
      "pension (net pay arrangement)": pension,
      "Gift Aid given": giftAidGiven,
      "Gift Aid grossed up": giftAidGross,
    },
    output: round(pension.plus(giftAidGross), R),
    legalRef: rules.giftAid.legalRef,
    note: rules.giftAid.note,
    unit: "money",
  });

  /* 4. Adjusted net income and the allowance taper --------------------------- */
  const adjustedNet = trace.add({
    id: "gb-4",
    label: "Adjusted net income",
    formula: `${f(gross)} - ${f(pension)} (pension) - ${f(giftAidGross)} (gross Gift Aid)`,
    inputs: { gross, pension, "gross Gift Aid": giftAidGross },
    output: floorZero(round(gross.minus(pension).minus(giftAidGross), R)),
    note: "This is the figure that drives the personal allowance taper, not your gross pay.",
    unit: "money",
  });

  const pa = rules.personalAllowance;
  const taperStart = d(pa.taperStart);
  const fullAllowance = d(pa.amount);
  const excess = floorZero(adjustedNet.minus(taperStart));
  const withdrawn = min(round(excess.times(d(pa.taperRate)), R), fullAllowance);
  const allowance = trace.add({
    id: "gb-5",
    label: "Personal allowance",
    formula: excess.gt(0)
      ? `${f(fullAllowance)} - ${f(withdrawn)} (GBP 1 withdrawn for every GBP 2 of the ${f(excess)} above ${f(taperStart)})`
      : `${f(fullAllowance)} (full allowance)`,
    inputs: {
      "full allowance": fullAllowance,
      "adjusted net income": adjustedNet,
      "taper start": taperStart,
      withdrawn,
    },
    output: floorZero(fullAllowance.minus(withdrawn)),
    legalRef: pa.legalRef,
    note: pa.note,
    unit: "money",
  });

  /* 5. Taxable income --------------------------------------------------------- */
  const taxable = trace.add({
    id: "gb-6",
    label: "Taxable income",
    formula: `max(0, ${f(gross)} - ${f(pension)} - ${f(allowance)})`,
    inputs: { gross, pension, "personal allowance": allowance },
    output: floorZero(round(gross.minus(pension).minus(allowance), R)),
    note: "Gift Aid is NOT deducted here. It extends the bands instead, which is the next step.",
    unit: "money",
  });

  /* 6. Bands, extended by any Gift Aid ---------------------------------------- */
  const extendedScale: ScaleSpec = {
    ...region.scale,
    bands: region.scale.bands.map((b: BandSpec) =>
      b.upTo === null ? b : { ...b, upTo: d(b.upTo).plus(giftAidGross).toString() },
    ),
  };
  const scaleUsed = giftAidGross.gt(0) ? extendedScale : region.scale;
  const scale = evaluateScale(taxable, scaleUsed, R);

  const tax = trace.add({
    id: "gb-7",
    label: `Income tax (${region.name})`,
    formula: giftAidGross.gt(0)
      ? `bands(${f(taxable)}) with every band limit raised by ${f(giftAidGross)} of gross Gift Aid`
      : `bands(${f(taxable)})`,
    inputs: { "taxable income": taxable, "band extension": giftAidGross },
    output: scale.total,
    legalRef: region.scale.legalRef,
    note: region.scale.note,
    bands: scale.rows,
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "gb-8",
    label: "Refund or amount owing",
    formula: `${f(withheld)} (PAYE deducted) - ${f(tax)} (income tax due)`,
    inputs: { "PAYE deducted": withheld, "income tax": tax },
    output: round(withheld.minus(tax), R),
    note: "National Insurance is not part of this comparison: it is charged per pay period and is not reconciled at the end of the year.",
    unit: "money",
  });

  if (excess.gt(0) && allowance.gt(0)) {
    warnings.push(
      "Your adjusted net income is inside the personal allowance taper, so each extra pound is effectively taxed at 60% (or 67.5% in Scotland). A pension contribution or Gift Aid donation that brings you under GBP 100,000 is worth far more than its face value here.",
    );
  }
  if (region.code === "scotland") {
    warnings.push(
      "Scottish rates apply to employment income only. Savings and dividend income are taxed at the rates for the rest of the UK, which this app does not model.",
    );
  }

  return { trace, grossAssessed: gross, social: national, incomeTax: tax, withheld, months, warnings };
}

export const gbAdapter: CountryAdapter = {
  country: "GB",
  currency: "GBP",
  label: "United Kingdom",
  contributionLabel: "National Insurance",
  regionLabel: "Where you live",
  regionNote:
    "Scotland sets its own rates and bands for employment income: six bands instead of three, and a top rate of 48% rather than 45%. A result without this choice would be meaningless. Welsh rates are currently set at the same level as England's.",

  years: () => genericYears("GB"),
  regions: (year) => genericRegions("GB", year),

  fields(year): FieldSpec[] {
    return loadGeneric<GbRules>("GB", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<GbRules>("GB", input.year);
    const region = genericRegion<GbRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "GB",
      currency: "GBP",
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("gb", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Watch this figure between GBP 100,000 and GBP 125,140, where the allowance taper pushes the effective rate to 60%.",
    });
  },
};
