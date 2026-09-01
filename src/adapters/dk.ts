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
import dk2026 from "../../rules/dk/2026/national.json";

registerGeneric("DK", 2026, dk2026);

interface DkRegion extends GenericRegion {
  municipalRate: string;
}

interface DkRules extends GenericRuleset {
  amBidrag: { legalRef: string; rate: string; note: string };
  employmentAllowance: { legalRef: string; rate: string; maximum: string; note: string };
  personalAllowance: { legalRef: string; amount: string; note: string };
  stateTaxes: {
    legalRef: string;
    bundskatRate: string;
    note: string;
    tiers: Array<{ name: string; threshold: string; rate: string }>;
  };
}

const LOCALE = "da-DK";
const f = (v: Decimal) => formatPlain(v, "DKK", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(3).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * Denmark's pipeline. The order is what makes it distinctive: the 8% labour
 * market contribution comes off FIRST, before any allowance, and every later
 * tax is charged on the 92% that remains. Then two different bases run in
 * parallel - bundskat and the state tiers use personal income, while municipal
 * tax uses taxable income after the employment allowance - so a single
 * deduction reduces one tax and not the other.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<DkRules>("DK", input.year);
  const region = genericRegion<DkRegion>(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };

  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "dk-1",
    label: "Bruttoloen",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 1. AM-bidrag, before anything else -------------------------------------------- */
  const am = trace.add({
    id: "dk-2",
    label: "Arbejdsmarkedsbidrag (AM-bidrag)",
    formula: `${pct(d(rules.amBidrag.rate))} x ${f(gross)}`,
    inputs: { sats: d(rules.amBidrag.rate) },
    output: round(gross.times(d(rules.amBidrag.rate)), R),
    legalRef: rules.amBidrag.legalRef,
    note: rules.amBidrag.note,
    unit: "money",
  });

  const personalIncome = trace.add({
    id: "dk-3",
    label: "Personlig indkomst",
    formula: `${f(gross)} - ${f(am)} (AM-bidrag)`,
    inputs: { bruttoloen: gross, "AM-bidrag": am },
    output: floorZero(round(gross.minus(am), R)),
    note: "Every tax below is charged on this figure, not on gross pay.",
    unit: "money",
  });

  /* 2. Beskaeftigelsesfradrag ------------------------------------------------------ */
  const ea = rules.employmentAllowance;
  const allowance = min(round(personalIncome.times(d(ea.rate)), R), d(ea.maximum));
  const taxableIncome = trace.add({
    id: "dk-4",
    label: "Skattepligtig indkomst",
    formula: `${f(personalIncome)} - ${f(allowance)} (beskaeftigelsesfradrag ${pct(d(ea.rate))}, max ${f(d(ea.maximum))})`,
    inputs: { "personlig indkomst": personalIncome, beskaeftigelsesfradrag: allowance },
    output: floorZero(round(personalIncome.minus(allowance), R)),
    legalRef: ea.legalRef,
    note: ea.note,
    unit: "money",
  });

  /* 3. Kommuneskat ----------------------------------------------------------------- */
  const personfradrag = d(rules.personalAllowance.amount);
  const municipalBase = floorZero(round(taxableIncome.minus(personfradrag), R));
  const municipal = trace.add({
    id: "dk-5",
    label: `Kommuneskat (${region.name})`,
    formula: `${pct(d(region.municipalRate))} x (${f(taxableIncome)} - ${f(personfradrag)})`,
    inputs: { grundlag: municipalBase, sats: d(region.municipalRate), personfradrag },
    output: round(municipalBase.times(d(region.municipalRate)), R),
    legalRef: "Kommunal indkomstskat",
    note: region.note,
    unit: "money",
  });

  /* 4. Bundskat -------------------------------------------------------------------- */
  const bundBase = floorZero(round(personalIncome.minus(personfradrag), R));
  const bundskat = trace.add({
    id: "dk-6",
    label: "Bundskat",
    formula: `${pct(d(rules.stateTaxes.bundskatRate))} x (${f(personalIncome)} - ${f(personfradrag)})`,
    inputs: { grundlag: bundBase, sats: d(rules.stateTaxes.bundskatRate) },
    output: round(bundBase.times(d(rules.stateTaxes.bundskatRate)), R),
    legalRef: rules.stateTaxes.legalRef,
    note: "Charged on personal income, so the employment allowance does not reduce it.",
    unit: "money",
  });

  /* 5. Mellemskat, topskat and top-topskat ---------------------------------------- */
  const tierAmounts = rules.stateTaxes.tiers.map((t) =>
    round(floorZero(personalIncome.minus(d(t.threshold))).times(d(t.rate)), R),
  );
  const stateTiers = trace.add({
    id: "dk-7",
    label: "Mellemskat, topskat og top-topskat",
    formula: rules.stateTaxes.tiers
      .map(
        (t, i) =>
          `${t.name} ${pct(d(t.rate))} x max(0, ${f(personalIncome)} - ${f(d(t.threshold))}) = ${f(tierAmounts[i])}`,
      )
      .join("; "),
    inputs: Object.fromEntries(rules.stateTaxes.tiers.map((t) => [t.name, d(t.threshold)])),
    output: round(sum(tierAmounts), R),
    legalRef: rules.stateTaxes.legalRef,
    note: rules.stateTaxes.note,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "dk-8",
    label: "Samlet skat",
    formula: `${f(municipal)} (kommuneskat) + ${f(bundskat)} (bundskat) + ${f(stateTiers)} (stats-tillaeg)`,
    inputs: { kommuneskat: municipal, bundskat, "mellem-, top- og top-topskat": stateTiers },
    output: round(municipal.plus(bundskat).plus(stateTiers), R),
    note: "The skatteloft, which caps the marginal rate at 60,5% including AM-bidrag, is not applied here.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "dk-9",
    label: "Overskydende skat eller restskat",
    formula: `${f(withheld)} (A-skat) - ${f(totalTax)}`,
    inputs: { "A-skat": withheld, skat: totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  if (personalIncome.gt(d(rules.stateTaxes.tiers[0].threshold))) {
    warnings.push(
      "You are into the mellemskat or topskat range. The tax ceiling that caps the combined marginal rate at 60,5% is not applied here, so the figure may be slightly overstated at the very top.",
    );
  }

  return {
    trace,
    grossAssessed: gross,
    social: am,
    incomeTax: totalTax,
    withheld,
    months,
    warnings,
  };
}

export const dkAdapter: CountryAdapter = {
  country: "DK",
  currency: "DKK",
  locale: LOCALE,
  label: "Denmark",
  contributionLabel: "AM-bidrag",
  contributionNote: "Charged on gross pay before any allowance.",
  regionLabel: "Kommune",
  regionNote:
    "Municipal tax is the largest single component of a Danish tax bill and it varies from about 22,5% to 27,8% depending on where you live. Choosing the wrong one moves the answer by several thousand kroner.",

  years: () => genericYears("DK"),
  regions: (year) => genericRegions("DK", year),

  fields(year): FieldSpec[] {
    return loadGeneric<DkRules>("DK", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<DkRules>("DK", input.year);
    const region = genericRegion<DkRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "DK",
      currency: "DKK",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("dk", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "AM-bidrag is charged first, so an extra krone of gross pay only adds 92 oere to the base of every tax below it.",
    });
  },
};
