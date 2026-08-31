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
import { evaluateScale, marginalRateAt } from "../engine/brackets";
import { Trace, serialiseTrace } from "../engine/trace";
import { loadCa, caRegions, caYears, stamp } from "../engine/registry";
import {
  readMonthly,
  readAnnual,
  monthsWorked,
  withProbe,
  MONTHS,
} from "../engine/inputs";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import type { CaProvinceRules } from "../engine/registry";

const f = (v: Decimal) => formatPlain(v, "CAD");
const pct = (v: Decimal) => `${v.times(100).toFixed(3).replace(/\.?0+$/, "")}%`;

interface Core {
  trace: Trace;
  employmentIncome: Decimal;
  cpp: Decimal;
  ei: Decimal;
  incomeTax: Decimal;
  withheld: Decimal;
  months: number;
  warnings: string[];
  marginalStatutory: Decimal;
}

/**
 * Canada's pipeline. Tax is computed on full taxable income and then reduced by
 * non-refundable credits valued at the LOWEST bracket rate - which is not the
 * same thing as deducting an allowance from income. Ontario then charges a
 * surtax on the provincial tax that remains after those credits.
 */
function core(input: CalcInput, probe: Decimal): Core {
  const { federal, region } = loadCa(input.year, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: federal.rounding.moneyDp, mode: federal.rounding.mode };

  /* 1. Employment income -------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const employmentIncome = trace.add({
    id: "ca-1",
    label: "Employment income (line 10100)",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    note:
      months === 12
        ? undefined
        : `Only ${months} month(s) carry income. A partial year is taxed on the actual total; it is never annualised.`,
    unit: "money",
  });

  /* 2. CPP contributions --------------------------------------------------- */
  const cppSpec = federal.cpp;
  const pensionable = min(employmentIncome, d(cppSpec.ympe));
  const cppBaseEarnings = floorZero(pensionable.minus(d(cppSpec.basicExemption)));
  const cpp1 = min(round(cppBaseEarnings.times(d(cppSpec.rate)), R), d(cppSpec.maxContribution));
  const cpp2Earnings = floorZero(min(employmentIncome, d(cppSpec.yampe)).minus(d(cppSpec.ympe)));
  const cpp2 = min(round(cpp2Earnings.times(d(cppSpec.cpp2Rate)), R), d(cppSpec.cpp2MaxContribution));

  const cpp = trace.add({
    id: "ca-2",
    label: "CPP contributions",
    formula: `CPP1 = (min(${f(employmentIncome)}, ${f(d(cppSpec.ympe))}) - ${f(d(cppSpec.basicExemption))}) x ${pct(d(cppSpec.rate))} = ${f(cpp1)}; CPP2 = (min(${f(employmentIncome)}, ${f(d(cppSpec.yampe))}) - ${f(d(cppSpec.ympe))}) x ${pct(d(cppSpec.cpp2Rate))} = ${f(cpp2)}`,
    inputs: {
      YMPE: d(cppSpec.ympe),
      YAMPE: d(cppSpec.yampe),
      "basic exemption": d(cppSpec.basicExemption),
      CPP1: cpp1,
      CPP2: cpp2,
    },
    output: round(cpp1.plus(cpp2), R),
    legalRef: cppSpec.legalRef,
    note: cppSpec.note,
    unit: "money",
  });

  const cppBaseCredit = round(cppBaseEarnings.times(d(cppSpec.baseRate)), R);
  const cppEnhancedDeduction = round(
    cppBaseEarnings.times(d(cppSpec.enhancedRate)).plus(cpp2),
    R,
  );

  /* 3. EI premiums --------------------------------------------------------- */
  const ei = trace.add({
    id: "ca-3",
    label: "EI premiums",
    formula: `min(${f(employmentIncome)}, ${f(d(federal.ei.mie))}) x ${pct(d(federal.ei.rate))}`,
    inputs: { MIE: d(federal.ei.mie), rate: d(federal.ei.rate), maximum: d(federal.ei.maxPremium) },
    output: min(
      round(min(employmentIncome, d(federal.ei.mie)).times(d(federal.ei.rate)), R),
      d(federal.ei.maxPremium),
    ),
    legalRef: federal.ei.legalRef,
    unit: "money",
  });

  /* 4. Net income (line 23600) --------------------------------------------- */
  const rrsp = readAnnual(v, "rrsp");
  const unionDues = readAnnual(v, "unionDues");
  const childcare = readAnnual(v, "childcare");
  const moving = readAnnual(v, "moving");
  const deductions = sum([rrsp, unionDues, childcare, moving, cppEnhancedDeduction]);

  const netIncome = trace.add({
    id: "ca-4",
    label: "Net income (line 23600)",
    formula: `${f(employmentIncome)} - ${f(rrsp)} (RRSP) - ${f(unionDues)} (dues) - ${f(childcare)} (childcare) - ${f(moving)} (moving) - ${f(cppEnhancedDeduction)} (enhanced CPP, line 22215)`,
    inputs: {
      "employment income": employmentIncome,
      RRSP: rrsp,
      "union and professional dues": unionDues,
      childcare,
      moving,
      "enhanced CPP deduction": cppEnhancedDeduction,
    },
    output: floorZero(round(employmentIncome.minus(deductions), R)),
    note: "The enhanced CPP contribution and all of CPP2 are deducted from income here. Only the 4.95% base portion becomes a credit later.",
    unit: "money",
  });

  /* 5. Taxable income (line 26000) ----------------------------------------- */
  const taxableIncome = trace.add({
    id: "ca-5",
    label: "Taxable income (line 26000)",
    formula: `${f(netIncome)} - 0 (no Division C deductions modelled in v1)`,
    inputs: { "net income": netIncome },
    output: netIncome,
    unit: "money",
  });

  /* 6. Federal tax before credits ------------------------------------------ */
  const fedScale = evaluateScale(taxableIncome, federal.brackets, R);
  const fedBefore = trace.add({
    id: "ca-6",
    label: "Federal tax before credits",
    formula: `federal_brackets(${f(taxableIncome)})`,
    inputs: { "taxable income": taxableIncome },
    output: fedScale.total,
    legalRef: federal.brackets.legalRef,
    note: federal.brackets.note,
    bands: fedScale.rows,
    unit: "money",
  });

  /* 7. Federal non-refundable credits, valued at the lowest rate ------------ */
  const lowest = d(federal.lowestRate);
  const bpaSpec = federal.basicPersonalAmount;
  let bpa = d(bpaSpec.max);
  let bpaFormula = `${f(d(bpaSpec.max))} (full amount)`;
  if (bpaSpec.phaseOutStart && bpaSpec.phaseOutEnd) {
    const start = d(bpaSpec.phaseOutStart);
    const end = d(bpaSpec.phaseOutEnd);
    if (netIncome.gt(start)) {
      if (netIncome.gte(end)) {
        bpa = d(bpaSpec.min);
        bpaFormula = `${f(d(bpaSpec.min))} (fully phased out above ${f(end)})`;
      } else {
        const taper = d(bpaSpec.max)
          .minus(d(bpaSpec.min))
          .times(netIncome.minus(start).dividedBy(end.minus(start)));
        bpa = round(d(bpaSpec.max).minus(taper), R);
        bpaFormula = `${f(d(bpaSpec.max))} - (${f(d(bpaSpec.max))} - ${f(d(bpaSpec.min))}) x (${f(netIncome)} - ${f(start)}) / (${f(end)} - ${f(start)})`;
      }
    }
  }

  const employmentAmount = min(d(federal.canadaEmploymentAmount.amount), employmentIncome);
  const fedMedicalThreshold = min(
    round(netIncome.times(d(federal.medical.percentOfNetIncome)), R),
    d(federal.medical.fixedThreshold),
  );
  const medicalClaimed = readAnnual(v, "medical");
  const fedMedicalEligible = floorZero(medicalClaimed.minus(fedMedicalThreshold));

  const creditBase = sum([bpa, cppBaseCredit, ei, employmentAmount, fedMedicalEligible]);
  const creditsExDonations = round(creditBase.times(lowest), R);

  trace.add({
    id: "ca-7a",
    label: "Federal Basic Personal Amount",
    formula: bpaFormula,
    inputs: { "net income": netIncome, "maximum BPA": d(bpaSpec.max), "minimum BPA": d(bpaSpec.min) },
    output: bpa,
    legalRef: "ITA s. 118(1.1)",
    note: bpaSpec.note,
    unit: "money",
  });

  trace.add({
    id: "ca-7b",
    label: "Federal non-refundable credits (excluding donations)",
    formula: `(${f(bpa)} BPA + ${f(cppBaseCredit)} CPP base + ${f(ei)} EI + ${f(employmentAmount)} Canada employment + ${f(fedMedicalEligible)} medical) x ${pct(lowest)}`,
    inputs: {
      BPA: bpa,
      "CPP base contributions": cppBaseCredit,
      "EI premiums": ei,
      "Canada employment amount": employmentAmount,
      "medical above threshold": fedMedicalEligible,
      "medical threshold applied": fedMedicalThreshold,
      "credit rate": lowest,
    },
    output: creditsExDonations,
    legalRef: "ITA s. 118, 118.2, 118.7",
    note: `Credits are valued at the lowest bracket rate (${pct(lowest)}), not at your marginal rate. Medical expenses count only above the lesser of 3% of net income and ${f(d(federal.medical.fixedThreshold))}.`,
    unit: "money",
  });

  const donationsGiven = readAnnual(v, "donations");
  const donationLimit = round(netIncome.times(d(federal.donations.netIncomeLimitPercent)), R);
  const donationBase = min(donationsGiven, donationLimit);
  const donTier1 = min(donationBase, d(federal.donations.tier1Limit));
  const donExcess = floorZero(donationBase.minus(d(federal.donations.tier1Limit)));
  const topThresholdBand = federal.brackets.bands[federal.brackets.bands.length - 2];
  const topThreshold = d(topThresholdBand?.upTo ?? 0);
  const incomeInTopBracket = floorZero(taxableIncome.minus(topThreshold));
  const donAtTop = min(donExcess, incomeInTopBracket);
  const donAtMid = donExcess.minus(donAtTop);
  const donationCredit = round(
    donTier1
      .times(lowest)
      .plus(donAtTop.times(d(federal.donations.topRate)))
      .plus(donAtMid.times(d(federal.donations.tier2Rate))),
    R,
  );

  trace.add({
    id: "ca-7c",
    label: "Federal donation credit",
    formula: donationBase.isZero()
      ? "0 - no donations entered"
      : `${pct(lowest)} x ${f(donTier1)} + ${pct(d(federal.donations.topRate))} x ${f(donAtTop)} + ${pct(d(federal.donations.tier2Rate))} x ${f(donAtMid)}`,
    inputs: {
      "donations claimed": donationsGiven,
      "75% of net income limit": donationLimit,
      "first 200": donTier1,
      "excess credited at 33%": donAtTop,
      "excess credited at 29%": donAtMid,
    },
    output: donationCredit,
    legalRef: federal.donations.legalRef,
    note: federal.donations.note,
    unit: "money",
  });

  /* 8. Federal tax --------------------------------------------------------- */
  const federalTax = trace.add({
    id: "ca-8",
    label: "Federal tax",
    formula: `max(0, ${f(fedBefore)} - ${f(creditsExDonations)} - ${f(donationCredit)})`,
    inputs: {
      "tax before credits": fedBefore,
      credits: creditsExDonations,
      "donation credit": donationCredit,
    },
    output: floorZero(round(fedBefore.minus(creditsExDonations).minus(donationCredit), R)),
    unit: "money",
  });

  /* 9-11. Provincial tax ---------------------------------------------------- */
  const prov: CaProvinceRules = region;
  const provScale = evaluateScale(taxableIncome, prov.brackets, R);
  const provBefore = trace.add({
    id: "ca-9",
    label: `${prov.regionName} tax before credits`,
    formula: `${prov.regionName.toLowerCase()}_brackets(${f(taxableIncome)})`,
    inputs: { "taxable income": taxableIncome },
    output: provScale.total,
    legalRef: prov.brackets.legalRef,
    note: prov.brackets.note,
    bands: provScale.rows,
    unit: "money",
  });

  const provCreditRate = d(prov.creditRate);
  const provBpa = d(prov.basicPersonalAmount.max);
  const provMedicalThreshold = min(
    round(netIncome.times(d(prov.medical.percentOfNetIncome)), R),
    d(prov.medical.fixedThreshold),
  );
  const provMedicalEligible = floorZero(medicalClaimed.minus(provMedicalThreshold));
  const provCreditBase = sum([provBpa, cppBaseCredit, ei, provMedicalEligible]);
  const provDonTier1 = min(donationBase, d(prov.donations.tier1Limit));
  const provDonExcess = floorZero(donationBase.minus(d(prov.donations.tier1Limit)));
  const provDonationCredit = round(
    provDonTier1.times(provCreditRate).plus(provDonExcess.times(d(prov.donations.tier2Rate))),
    R,
  );
  const provCredits = round(provCreditBase.times(provCreditRate), R).plus(provDonationCredit);

  trace.add({
    id: "ca-10",
    label: `${prov.regionName} non-refundable credits`,
    formula: `(${f(provBpa)} BPA + ${f(cppBaseCredit)} CPP base + ${f(ei)} EI + ${f(provMedicalEligible)} medical) x ${pct(provCreditRate)} + ${f(provDonationCredit)} donations`,
    inputs: {
      "provincial BPA": provBpa,
      "provincial credit rate": provCreditRate,
      "donation credit": provDonationCredit,
    },
    output: provCredits,
    note:
      prov.regionCode === "ab"
        ? "Alberta taxes the first bracket at 8% but still values non-refundable credits at 10%, so the credit rate deliberately differs from the lowest bracket rate."
        : "Each province sets its own basic personal amount and values credits at its own lowest rate.",
    unit: "money",
  });

  const provAfterCredits = trace.add({
    id: "ca-10b",
    label: `${prov.regionName} tax after credits`,
    formula: `max(0, ${f(provBefore)} - ${f(provCredits)})`,
    inputs: { "tax before credits": provBefore, credits: provCredits },
    output: floorZero(round(provBefore.minus(provCredits), R)),
    unit: "money",
  });

  let surtax = ZERO;
  if (prov.surtax) {
    const parts = prov.surtax.tiers.map((t) =>
      round(floorZero(provAfterCredits.minus(d(t.threshold))).times(d(t.rate)), R),
    );
    surtax = sum(parts);
    trace.add({
      id: "ca-11",
      label: `${prov.regionName} surtax`,
      formula: prov.surtax.tiers
        .map(
          (t, i) =>
            `${pct(d(t.rate))} x max(0, ${f(provAfterCredits)} - ${f(d(t.threshold))}) = ${f(parts[i])}`,
        )
        .join(" + "),
      inputs: Object.fromEntries(
        prov.surtax.tiers.map((t, i) => [`threshold ${i + 1}`, d(t.threshold)]),
      ),
      output: round(surtax, R),
      legalRef: prov.surtax.legalRef,
      note: prov.surtax.note,
      unit: "money",
    });
  }

  let healthPremium = ZERO;
  if (prov.healthPremium) {
    const band = prov.healthPremium.bands.find(
      (b) => taxableIncome.gt(d(b.over)) && (b.upTo === null || taxableIncome.lte(d(b.upTo))),
    );
    if (band) {
      healthPremium = min(
        round(d(band.base).plus(taxableIncome.minus(d(band.over)).times(d(band.rate))), R),
        d(band.max),
      );
    }
    trace.add({
      id: "ca-11b",
      label: `${prov.regionName} Health Premium`,
      formula: band
        ? `min(${f(d(band.base))} + ${pct(d(band.rate))} x (${f(taxableIncome)} - ${f(d(band.over))}), ${f(d(band.max))})`
        : `0 - taxable income at or below ${f(d(prov.healthPremium.bands[0].over))}`,
      inputs: { "taxable income": taxableIncome },
      output: healthPremium,
      legalRef: prov.healthPremium.legalRef,
      note: prov.healthPremium.note,
      unit: "money",
    });
  }

  const provincialTotal = trace.add({
    id: "ca-11c",
    label: `${prov.regionName} tax payable`,
    formula: `${f(provAfterCredits)} + ${f(surtax)} (surtax) + ${f(healthPremium)} (health premium)`,
    inputs: { "after credits": provAfterCredits, surtax, "health premium": healthPremium },
    output: round(provAfterCredits.plus(surtax).plus(healthPremium), R),
    unit: "money",
  });

  /* 12. Totals ------------------------------------------------------------- */
  const incomeTax = trace.add({
    id: "ca-12",
    label: "Total income tax",
    formula: `${f(federalTax)} (federal) + ${f(provincialTotal)} (${prov.regionName})`,
    inputs: { federal: federalTax, provincial: provincialTotal },
    output: round(federalTax.plus(provincialTotal), R),
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "ca-13",
    label: "Refund or balance owing",
    formula: `${f(withheld)} (tax withheld) - ${f(incomeTax)} (total income tax)`,
    inputs: { "tax withheld": withheld, "income tax": incomeTax },
    output: round(withheld.minus(incomeTax), R),
    note: "Positive means a refund; negative means a balance owing. CPP and EI are withheld separately and are not part of this comparison.",
    unit: "money",
  });

  if (donationsGiven.gt(donationBase)) {
    warnings.push(
      `Donations were limited to 75% of net income (${f(donationLimit)}). The excess can be carried forward for five years, which v1 does not track.`,
    );
  }
  if (
    bpaSpec.phaseOutStart &&
    netIncome.gt(d(bpaSpec.phaseOutStart)) &&
    bpaSpec.phaseOutEnd &&
    netIncome.lt(d(bpaSpec.phaseOutEnd))
  ) {
    warnings.push(
      "Your net income sits inside the federal BPA phase-out band, so each additional dollar is taxed at roughly 29.29% federally rather than 29%.",
    );
  }
  if (months > 0 && months < 12) {
    warnings.push(
      `Income was entered for ${months} of 12 months. The year is taxed on the actual total; the BPA and other credits are annual amounts and are not prorated.`,
    );
  }

  const marginalStatutory = marginalRateAt(taxableIncome, federal.brackets).plus(
    marginalRateAt(taxableIncome, prov.brackets),
  );

  return {
    trace,
    employmentIncome,
    cpp,
    ei,
    incomeTax,
    withheld,
    months,
    warnings,
    marginalStatutory,
  };
}

const PROBE = new Decimal(100);

export const caAdapter: CountryAdapter = {
  country: "CA",
  currency: "CAD",
  label: "Canada",
  contributionLabel: "CPP + EI",
  regionLabel: "Province",
  regionNote:
    "Provincial tax has its own brackets, its own basic personal amount, and in Ontario a surtax on tax owing. A result without a province would be meaningless. Quebec is out of scope: it levies its own return.",

  years: () => caYears(),

  regions: (year) => caRegions(year),

  fields(year, regionCode): FieldSpec[] {
    const { federal, region } = loadCa(year, regionCode);
    return [...federal.inputSchema, ...region.inputSchema];
  },

  compute(input: CalcInput): CalcResult {
    const { federal, region } = loadCa(input.year, input.regionCode);
    const R: Rounding = { dp: federal.rounding.moneyDp, mode: federal.rounding.mode };

    const base = core(input, ZERO);
    const bumped = core(input, PROBE);
    const marginal = bumped.incomeTax.minus(base.incomeTax).dividedBy(PROBE);

    const social = base.cpp.plus(base.ei);
    const takeHome = base.employmentIncome.minus(social).minus(base.incomeTax);
    const denom = base.employmentIncome.isZero() ? new Decimal(1) : base.employmentIncome;

    base.trace.add({
      id: "ca-14",
      label: "Effective marginal rate",
      formula: `(income tax on ${f(base.employmentIncome.plus(PROBE))} - income tax on ${f(base.employmentIncome)}) / ${f(PROBE)}`,
      inputs: {
        "current income tax": base.incomeTax,
        "income tax with 100 more": bumped.incomeTax,
        "statutory federal + provincial bracket rate": base.marginalStatutory,
      },
      output: marginal,
      note: "Measured by adding $100 of gross pay and re-running the whole pipeline, so it reflects the BPA phase-out and the Ontario surtax rather than just the bracket rates.",
      unit: "percent",
    });

    return {
      country: "CA",
      year: input.year,
      regionCode: region.regionCode,
      regionName: region.regionName,
      currency: "CAD",
      summary: {
        annualGross: base.employmentIncome,
        socialContributions: social,
        incomeTax: base.incomeTax,
        totalDeductions: social.plus(base.incomeTax),
        takeHome,
        monthlyTakeHome: round(takeHome.dividedBy(12), R),
        effectiveRateOnGross: social.plus(base.incomeTax).dividedBy(denom),
        effectiveIncomeTaxRate: base.incomeTax.dividedBy(denom),
        marginalRate: marginal,
        withheld: base.withheld,
        balance: round(base.withheld.minus(base.incomeTax), R),
        monthsWorked: base.months,
      },
      steps: serialiseTrace(base.trace),
      rulesets: [stamp("ca-federal", federal), stamp("ca-province", region)],
      warnings: base.warnings,
      computedAt: new Date().toISOString(),
    };
  },
};

export { core as caCore };
export const _internals = { max, min };
