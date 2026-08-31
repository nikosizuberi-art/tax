import esNational2026 from "../../rules/es/2026/_national.json";
import esMadrid2026 from "../../rules/es/2026/madrid.json";
import esCataluna2026 from "../../rules/es/2026/cataluna.json";
import esAndalucia2026 from "../../rules/es/2026/andalucia.json";
import esValencia2026 from "../../rules/es/2026/comunidad-valenciana.json";

import caFederal2026 from "../../rules/ca/2026/_federal.json";
import caOn2026 from "../../rules/ca/2026/on.json";
import caBc2026 from "../../rules/ca/2026/bc.json";
import caAb2026 from "../../rules/ca/2026/ab.json";

import type { FieldSpec, Provenance, RulesetStamp } from "./types";
import type { ScaleSpec } from "./brackets";

/* ------------------------------------------------------------------ Spain */

export interface EsNationalRules {
  rulesetVersion: string;
  year: number;
  currency: "EUR";
  provenance: Provenance;
  verificationTodo?: string[];
  omissions?: string[];
  stateScale: ScaleSpec;
  savingsScale: ScaleSpec;
  socialSecurity: {
    legalRef: string;
    monthlyMaxBase: string;
    monthlyMinBase: string;
    rates: {
      contingenciasComunes: string;
      desempleoIndefinido: string;
      desempleoTemporal: string;
      formacionProfesional: string;
      mei: string;
    };
    note: string;
  };
  gastosDeducibles: {
    legalRef: string;
    otrosGastosGenerico: string;
    topeDefensaJuridica: string;
    topeColegiosProfesionales: string;
  };
  reduccionRendimientosTrabajo: {
    legalRef: string;
    amount: string;
    floor: string;
    ceiling: string;
    taperFactor: string;
    otherIncomeLimit: string;
    note: string;
  };
  minimos: {
    legalRef: string;
    personal: string;
    mayor65: string;
    mayor75Extra: string;
    descendientes: string[];
    descendienteMenor3Extra: string;
    discapacidad33a64: string;
    discapacidad65mas: string;
  };
  pensionPlan: { legalRef: string; percentOfWorkIncome: string; absoluteCap: string; note: string };
  donations: {
    legalRef: string;
    tier1Limit: string;
    tier1Rate: string;
    tier2Rate: string;
    tier2RecurringRate: string;
    baseLimitPercent: string;
  };
  rounding: { moneyDp: number; mode: "half-up" | "half-even" | "down" | "up"; ratePercentDp: number };
  inputSchema: FieldSpec[];
}

export interface EsRegionalDeduction {
  id: string;
  label: string;
  rate: string;
  cap: string;
  inputId: string;
  eligibilityId: string;
  legalRef: string;
  help: string;
}

export interface EsRegionRules {
  rulesetVersion: string;
  regionCode: string;
  regionName: string;
  provenance: Provenance;
  generalScale: ScaleSpec;
  minimoOverrides: Partial<EsNationalRules["minimos"]> | null;
  regionalDeductions: EsRegionalDeduction[];
  inputSchema: FieldSpec[];
  omissions?: string[];
}

/* ----------------------------------------------------------------- Canada */

export interface CaFederalRules {
  rulesetVersion: string;
  year: number;
  currency: "CAD";
  provenance: Provenance;
  verificationTodo?: string[];
  omissions?: string[];
  lowestRate: string;
  brackets: ScaleSpec;
  basicPersonalAmount: {
    max: string;
    min: string;
    phaseOutStart: string | null;
    phaseOutEnd: string | null;
    note?: string;
  };
  cpp: {
    legalRef: string;
    ympe: string;
    yampe: string;
    basicExemption: string;
    rate: string;
    maxContribution: string;
    baseRate: string;
    enhancedRate: string;
    cpp2Rate: string;
    cpp2MaxContribution: string;
    note: string;
  };
  ei: { legalRef: string; mie: string; rate: string; maxPremium: string; note: string };
  canadaEmploymentAmount: { legalRef: string; amount: string; note: string };
  medical: { legalRef: string; percentOfNetIncome: string; fixedThreshold: string; note: string };
  donations: {
    legalRef: string;
    tier1Limit: string;
    tier2Rate: string;
    topRate: string;
    netIncomeLimitPercent: string;
    note: string;
  };
  rounding: { moneyDp: number; mode: "half-up" | "half-even" | "down" | "up"; ratePercentDp: number };
  inputSchema: FieldSpec[];
}

export interface CaProvinceRules {
  rulesetVersion: string;
  regionCode: string;
  regionName: string;
  provenance: Provenance;
  lowestRate: string;
  /** Deliberately separate from lowestRate: Alberta taxes at 8% but values credits at 10%. */
  creditRate: string;
  brackets: ScaleSpec;
  basicPersonalAmount: {
    max: string;
    min: string;
    phaseOutStart: string | null;
    phaseOutEnd: string | null;
  };
  surtax: { legalRef: string; note: string; tiers: Array<{ threshold: string; rate: string }> } | null;
  healthPremium: {
    legalRef: string;
    note: string;
    bands: Array<{ over: string; upTo: string | null; base: string; rate: string; max: string }>;
  } | null;
  medical: { percentOfNetIncome: string; fixedThreshold: string; note: string };
  donations: { tier1Limit: string; tier2Rate: string };
  inputSchema: FieldSpec[];
  omissions?: string[];
}

/* --------------------------------------------------------------- Registry */

const ES: Record<number, { national: EsNationalRules; regions: Record<string, EsRegionRules> }> = {
  2026: {
    national: esNational2026 as unknown as EsNationalRules,
    regions: {
      madrid: esMadrid2026 as unknown as EsRegionRules,
      cataluna: esCataluna2026 as unknown as EsRegionRules,
      andalucia: esAndalucia2026 as unknown as EsRegionRules,
      "comunidad-valenciana": esValencia2026 as unknown as EsRegionRules,
    },
  },
};

const CA: Record<number, { federal: CaFederalRules; regions: Record<string, CaProvinceRules> }> = {
  2026: {
    federal: caFederal2026 as unknown as CaFederalRules,
    regions: {
      on: caOn2026 as unknown as CaProvinceRules,
      bc: caBc2026 as unknown as CaProvinceRules,
      ab: caAb2026 as unknown as CaProvinceRules,
    },
  },
};

export function esYears(): number[] {
  return Object.keys(ES).map(Number).sort();
}

export function caYears(): number[] {
  return Object.keys(CA).map(Number).sort();
}

export function loadEs(year: number, regionCode: string) {
  const set = ES[year];
  if (!set) throw new Error(`No Spanish ruleset for ${year}`);
  const region = set.regions[regionCode];
  if (!region) throw new Error(`No Spanish regional ruleset for ${regionCode} in ${year}`);
  return { national: set.national, region };
}

export function loadCa(year: number, regionCode: string) {
  const set = CA[year];
  if (!set) throw new Error(`No Canadian ruleset for ${year}`);
  const region = set.regions[regionCode];
  if (!region) throw new Error(`No Canadian provincial ruleset for ${regionCode} in ${year}`);
  return { federal: set.federal, region };
}

export function esRegions(year: number) {
  const set = ES[year];
  if (!set) return [];
  return Object.values(set.regions).map((r) => ({ code: r.regionCode, name: r.regionName }));
}

export function caRegions(year: number) {
  const set = CA[year];
  if (!set) return [];
  return Object.values(set.regions).map((r) => ({ code: r.regionCode, name: r.regionName }));
}

export function stamp(
  id: string,
  r: {
    rulesetVersion: string;
    provenance: Provenance;
    verificationTodo?: string[];
    omissions?: string[];
  },
): RulesetStamp {
  return {
    id,
    version: r.rulesetVersion,
    provenance: r.provenance,
    verificationTodo: r.verificationTodo,
    omissions: r.omissions,
  };
}

/* ------------------------------------------------ Generic country registry */

/**
 * Spain and Canada keep one ruleset file per region, because the region is the
 * main axis of variation there. For the remaining countries the regional
 * dimension is small or absent, so each country-year is a single file with an
 * inline `regions` array. Both shapes are "add JSON, register the import".
 */
export interface GenericRegion {
  code: string;
  name: string;
  note?: string;
  [key: string]: unknown;
}

export interface GenericRuleset {
  rulesetVersion: string;
  country: string;
  year: number;
  yearLabel?: string;
  currency: string;
  provenance: Provenance;
  verificationTodo?: string[];
  omissions?: string[];
  regions: GenericRegion[];
  inputSchema: FieldSpec[];
  rounding: { moneyDp: number; mode: "half-up" | "half-even" | "down" | "up"; [k: string]: unknown };
  [key: string]: unknown;
}

const GENERIC: Record<string, Record<number, GenericRuleset>> = {};

export function registerGeneric(country: string, year: number, ruleset: unknown): void {
  GENERIC[country] ??= {};
  GENERIC[country][year] = ruleset as GenericRuleset;
}

export function loadGeneric<T extends GenericRuleset>(country: string, year: number): T {
  const set = GENERIC[country]?.[year];
  if (!set) throw new Error(`No ruleset for ${country} ${year}`);
  return set as T;
}

export function genericYears(country: string): number[] {
  return Object.keys(GENERIC[country] ?? {}).map(Number).sort();
}

export function genericRegions(country: string, year: number): Array<{ code: string; name: string }> {
  const set = GENERIC[country]?.[year];
  if (!set) return [];
  return set.regions.map((r) => ({ code: r.code, name: r.name }));
}

/** Resolve a region within a country-year ruleset, rejecting unknown codes. */
export function genericRegion<T extends GenericRegion>(set: GenericRuleset, code: string): T {
  const region = set.regions.find((r) => r.code === code);
  if (!region) throw new Error(`No region ${code} in ruleset ${set.rulesetVersion}`);
  return region as T;
}
