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
import { readMonthly, readAnnual, readEnum, monthsWorked, withProbe, MONTHS } from "../engine/inputs";
import { runPipeline, type CoreResult } from "../engine/pipeline";
import type { CalcInput, CalcResult, CountryAdapter, FieldSpec } from "../engine/types";
import fr2026 from "../../rules/fr/2026/national.json";

registerGeneric("FR", 2026, fr2026);

interface FrRules extends GenericRuleset {
  bareme: ScaleSpec;
  abattement: { legalRef: string; rate: string; minimum: string; maximum: string; note: string };
  quotientFamilial: { legalRef: string; capPerHalfPart: string; note: string };
  decote: {
    legalRef: string;
    singleCeiling: string;
    singleAmount: string;
    rate: string;
    note: string;
  };
  cehr: ScaleSpec;
  socialContributions: {
    legalRef: string;
    csgRate: string;
    csgDeductibleRate: string;
    crdsRate: string;
    assietteRate: string;
    otherEmployeeContributionsRate: string;
    note: string;
  };
  rounding: GenericRuleset["rounding"] & { finalTaxDp: number };
}

const LOCALE = "fr-FR";
const f = (v: Decimal) => formatPlain(v, "EUR", LOCALE);
const pct = (v: Decimal) => `${v.times(100).toFixed(2).replace(".", ",").replace(/,?0+$/, "")}%`;

/**
 * France's pipeline. The quotient familial is the mechanism nothing else here
 * has: taxable income is DIVIDED by the number of parts, run through the
 * bareme, and the result MULTIPLIED BACK. That is not the same as applying a
 * per-child allowance, and the saving it produces is then capped per half-part,
 * which requires computing the tax twice - once with the real parts and once at
 * one part - and comparing.
 *
 * The second oddity is that only 6.8 of the 9.2 CSG points are deductible, so
 * part of a social contribution is itself subject to income tax.
 */
function core(input: CalcInput, probe: Decimal): CoreResult {
  const rules = loadGeneric<FrRules>("FR", input.year);
  genericRegion(rules, input.regionCode);
  const v = input.values;
  const trace = new Trace();
  const warnings: string[] = [];
  const R: Rounding = { dp: rules.rounding.moneyDp, mode: rules.rounding.mode };
  const FINAL: Rounding = { dp: rules.rounding.finalTaxDp, mode: "half-up" };

  /* 1. Salaire brut ---------------------------------------------------------- */
  const monthlyGross = withProbe(readMonthly(v, "grossMonthly"), probe);
  const months = monthsWorked(monthlyGross);
  const gross = trace.add({
    id: "fr-1",
    label: "Salaire brut annuel",
    formula: `sum of ${months} month(s) with income`,
    inputs: Object.fromEntries(monthlyGross.map((m, i) => [MONTHS[i], m])),
    output: round(sum(monthlyGross), R),
    unit: "money",
  });

  /* 2. Cotisations sociales -------------------------------------------------- */
  const sc = rules.socialContributions;
  const assiette = round(gross.times(d(sc.assietteRate)), R);
  const csg = round(assiette.times(d(sc.csgRate)), R);
  const csgDeductible = round(assiette.times(d(sc.csgDeductibleRate)), R);
  const crds = round(assiette.times(d(sc.crdsRate)), R);
  const other = round(gross.times(d(sc.otherEmployeeContributionsRate)), R);
  const totalSocial = round(sum([csg, crds, other]), R);

  trace.add({
    id: "fr-2",
    label: "Cotisations sociales salariales",
    formula: `CSG ${pct(d(sc.csgRate))} x ${f(assiette)} = ${f(csg)}; CRDS ${pct(d(sc.crdsRate))} = ${f(crds)}; autres cotisations ${pct(d(sc.otherEmployeeContributionsRate))} x ${f(gross)} = ${f(other)}`,
    inputs: {
      "assiette CSG/CRDS (98,25%)": assiette,
      CSG: csg,
      "dont CSG deductible": csgDeductible,
      CRDS: crds,
      "autres cotisations": other,
    },
    output: totalSocial,
    legalRef: sc.legalRef,
    note: sc.note,
    unit: "money",
  });

  /* 3. Revenu net imposable --------------------------------------------------- */
  const ab = rules.abattement;
  const netBeforeAbattement = floorZero(round(gross.minus(csgDeductible).minus(other), R));
  const abattementRaw = round(netBeforeAbattement.times(d(ab.rate)), R);
  const abattement = min(max(abattementRaw, min(d(ab.minimum), netBeforeAbattement)), d(ab.maximum));
  const pension = readAnnual(v, "pensionContributions");

  const netImposable = trace.add({
    id: "fr-3",
    label: "Revenu net imposable",
    formula: `${f(gross)} - ${f(csgDeductible)} (CSG deductible) - ${f(other)} (cotisations) - ${f(abattement)} (abattement ${pct(d(ab.rate))}, plafond ${f(d(ab.maximum))}) - ${f(pension)} (PER)`,
    inputs: {
      "salaire brut": gross,
      "CSG deductible": csgDeductible,
      cotisations: other,
      abattement,
      "versements PER": pension,
    },
    output: floorZero(round(netBeforeAbattement.minus(abattement).minus(pension), R)),
    legalRef: ab.legalRef,
    note: "The non-deductible 2,4 points of CSG and the whole of CRDS stay inside the taxable base, so you pay income tax on money you never received.",
    unit: "money",
  });

  /* 4. Quotient familial ------------------------------------------------------ */
  const qf = rules.quotientFamilial;
  const parts = d(readEnum(v, "parts", "1"));
  const quotient = round(netImposable.dividedBy(parts), R);

  const taxAtParts = round(
    evaluateScale(quotient, rules.bareme, R).total.times(parts),
    R,
  );
  const taxAtOnePart = round(evaluateScale(netImposable, rules.bareme, R).total, R);

  const halfParts = parts.minus(1).times(2);
  const cap = round(halfParts.times(d(qf.capPerHalfPart)), R);
  // The saving from the extra half-parts may not exceed the cap.
  const uncappedSaving = floorZero(taxAtOnePart.minus(taxAtParts));
  const allowedSaving = min(uncappedSaving, cap);
  const capped = uncappedSaving.gt(cap);

  const scaleRows = evaluateScale(quotient, rules.bareme, R);
  trace.add({
    id: "fr-4",
    label: "Application du bareme au quotient familial",
    formula: `bareme(${f(netImposable)} / ${parts.toString()} part(s)) x ${parts.toString()}`,
    inputs: {
      "quotient familial": quotient,
      "nombre de parts": parts,
      "impot a 1 part": taxAtOnePart,
      "impot avec parts": taxAtParts,
    },
    output: taxAtParts,
    legalRef: rules.bareme.legalRef,
    note: rules.bareme.note,
    bands: scaleRows.rows,
    unit: "money",
  });

  const afterCap = trace.add({
    id: "fr-5",
    label: "Plafonnement du quotient familial",
    formula: parts.eq(1)
      ? "0 - a single part, so no cap applies"
      : `avantage de ${f(uncappedSaving)} plafonne a ${f(cap)} (${halfParts.toString()} demi-part(s) x ${f(d(qf.capPerHalfPart))})`,
    inputs: { "avantage brut": uncappedSaving, plafond: cap, "avantage retenu": allowedSaving },
    output: round(taxAtOnePart.minus(allowedSaving), R),
    legalRef: qf.legalRef,
    note: qf.note,
    unit: "money",
  });

  if (capped) {
    warnings.push(
      "Your quotient familial advantage was capped, so the last of your family parts is worth less than the first.",
    );
  }

  /* 5. Decote ----------------------------------------------------------------- */
  const dc = rules.decote;
  const ceiling = d(dc.singleCeiling);
  const decote = afterCap.lt(ceiling)
    ? min(floorZero(round(d(dc.singleAmount).minus(afterCap.times(d(dc.rate))), R)), afterCap)
    : ZERO;

  const afterDecote = trace.add({
    id: "fr-6",
    label: "Decote",
    formula: afterCap.lt(ceiling)
      ? `${f(d(dc.singleAmount))} - ${pct(d(dc.rate))} x ${f(afterCap)} = ${f(decote)}`
      : `0 - l'impot depasse le plafond de ${f(ceiling)}`,
    inputs: { "impot avant decote": afterCap, decote },
    output: floorZero(round(afterCap.minus(decote), R)),
    legalRef: dc.legalRef,
    note: dc.note,
    unit: "money",
  });

  /* 6. Contribution exceptionnelle sur les hauts revenus ---------------------- */
  const cehrScale = evaluateScale(netImposable, rules.cehr, R);
  const cehr = trace.add({
    id: "fr-7",
    label: "Contribution exceptionnelle sur les hauts revenus",
    formula: cehrScale.total.gt(0)
      ? `CEHR(${f(netImposable)})`
      : "0 - revenu inferieur au seuil de 250.000 EUR",
    inputs: { "revenu fiscal de reference": netImposable },
    output: cehrScale.total,
    legalRef: rules.cehr.legalRef,
    note: rules.cehr.note,
    bands: cehrScale.rows,
    unit: "money",
  });

  const totalTax = trace.add({
    id: "fr-8",
    label: "Impot total du",
    formula: `${f(afterDecote)} (impot sur le revenu) + ${f(cehr)} (CEHR)`,
    inputs: { "impot sur le revenu": afterDecote, CEHR: cehr },
    output: round(afterDecote.plus(cehr), FINAL),
    note: "The French administration rounds the assessed tax to the nearest euro.",
    unit: "money",
  });

  const withheld = round(sum(readMonthly(v, "taxWithheldMonthly")), R);
  trace.add({
    id: "fr-9",
    label: "Solde",
    formula: `${f(withheld)} (prelevement a la source) - ${f(totalTax)}`,
    inputs: { "preleve a la source": withheld, "impot du": totalTax },
    output: round(withheld.minus(totalTax), R),
    unit: "money",
  });

  return { trace, grossAssessed: gross, social: totalSocial, incomeTax: totalTax, withheld, months, warnings };
}

export const frAdapter: CountryAdapter = {
  country: "FR",
  currency: "EUR",
  locale: LOCALE,
  label: "France",
  contributionLabel: "Cotisations sociales",
  contributionNote: "CSG, CRDS and the employee share of the other contributions.",
  regionLabel: "Territoire",
  regionNote:
    "The bareme is national. The overseas departments have rate reductions that this version does not model, so there is a single option here.",

  years: () => genericYears("FR"),
  regions: (year) => genericRegions("FR", year),

  fields(year): FieldSpec[] {
    return loadGeneric<FrRules>("FR", year).inputSchema;
  },

  compute(input: CalcInput): CalcResult {
    const rules = loadGeneric<FrRules>("FR", input.year);
    const region = genericRegion<GenericRegion>(rules, input.regionCode);
    return runPipeline({
      input,
      core,
      country: "FR",
      currency: "EUR",
      locale: LOCALE,
      regionCode: region.code,
      regionName: region.name,
      rulesets: [stamp("fr", rules)],
      rounding: { dp: rules.rounding.moneyDp, mode: rules.rounding.mode },
      marginalNote:
        "Inside the decote range the marginal rate is inflated by the 45,25% withdrawal, and the quotient familial cap can raise it again.",
    });
  },
};
