import { describe, it, expect } from "vitest";
import { compute, adapters, COUNTRIES } from "../src/adapters";
import { perMonth, input } from "./helpers";
import type { CountryCode } from "../src/engine/types";

/**
 * Properties that must hold for every jurisdiction, at every income, whatever
 * the ruleset says. These are the guard rails: a ruleset edit that breaks one
 * of them is a bug in the numbers, not a new policy.
 */

const BASE_INCOMES = [
  0, 1, 500, 5000, 11000, 12450, 12451, 14047, 19747, 20200, 23000, 35200, 40000, 53891, 58523,
  60000, 74600, 85000, 100000, 117045, 125140, 150000, 181440, 200000, 220000, 258482, 300000,
  500000, 1000000,
];

interface Jurisdiction {
  country: CountryCode;
  region: string;
  /** Ceiling on the effective income tax rate: top rate plus any surcharge on it. */
  topEffectiveRate: number;
  /** Multiplier so the test incomes are realistic in the local currency. */
  scale: number;
  /** Some systems legitimately reach a ~100% marginal rate; see the note. */
  maxMarginal?: number;
}

const JURISDICTIONS: Jurisdiction[] = [
  { country: "ES", region: "madrid", topEffectiveRate: 0.245 + 0.205, scale: 1 },
  { country: "ES", region: "cataluna", topEffectiveRate: 0.245 + 0.255, scale: 1 },
  { country: "ES", region: "andalucia", topEffectiveRate: 0.245 + 0.225, scale: 1 },
  { country: "ES", region: "comunidad-valenciana", topEffectiveRate: 0.245 + 0.295, scale: 1 },
  { country: "CA", region: "on", topEffectiveRate: 0.33 + 0.1316 * 1.56 + 0.01, scale: 1 },
  { country: "CA", region: "bc", topEffectiveRate: 0.33 + 0.205, scale: 1 },
  { country: "CA", region: "ab", topEffectiveRate: 0.33 + 0.15, scale: 1 },
  // Hong Kong: capped by the 16% top standard rate, or 17% progressive.
  { country: "HK", region: "hk", topEffectiveRate: 0.17, scale: 8 },
  // Kuwait: no income tax at any income, which is itself the property.
  { country: "KW", region: "kw", topEffectiveRate: 0, scale: 0.05 },
  { country: "BG", region: "bg", topEffectiveRate: 0.1, scale: 1 },
  // Germany: 45% plus 5.5% solidarity surcharge and up to 9% church tax.
  { country: "DE", region: "uebrige-laender", topEffectiveRate: 0.45 * 1.145, scale: 1 },
  { country: "GB", region: "england-wales-ni", topEffectiveRate: 0.45, scale: 1 },
  { country: "GB", region: "scotland", topEffectiveRate: 0.48, scale: 1 },
  { country: "NL", region: "nl", topEffectiveRate: 0.495, scale: 1 },
  // Poland: 32% plus the 4% solidarity levy above a million zloty.
  { country: "PL", region: "pl", topEffectiveRate: 0.36, scale: 4 },
  { country: "SG", region: "sg", topEffectiveRate: 0.24, scale: 1.4 },
  // India: 30% grossed up by a 25% surcharge and then 4% cess. Marginal relief
  // at the rebate threshold legitimately produces a ~100% marginal rate, and
  // rounding the liability to the nearest ten rupees can nudge it just past it.
  { country: "IN", region: "in", topEffectiveRate: 0.3 * 1.25 * 1.04, scale: 90, maxMarginal: 1.2 },
  { country: "AU", region: "au", topEffectiveRate: 0.45 + 0.02, scale: 1 },
];

const at = (j: Jurisdiction, income: number) =>
  compute(
    input(j.country, j.region, {
      grossMonthly: perMonth((income * j.scale) / 12),
      age: 40,
      nationality: "kuwaiti",
    }),
  );

describe.each(JURISDICTIONS)("property: $country / $region", (j) => {
  const incomes = BASE_INCOMES;

  it("tax is monotonically non-decreasing in income", () => {
    let previous = -1;
    for (const income of incomes) {
      const tax = at(j, income).summary.incomeTax.toNumber();
      expect(tax).toBeGreaterThanOrEqual(previous - 0.01);
      previous = tax;
    }
  });

  it("take-home never decreases when gross increases", () => {
    let previous = -1;
    for (const income of incomes) {
      const takeHome = at(j, income).summary.takeHome.toNumber();
      expect(takeHome).toBeGreaterThanOrEqual(previous - 0.01);
      previous = takeHome;
    }
  });

  it("the effective rate never exceeds the top effective rate", () => {
    for (const income of incomes.filter((i) => i > 0)) {
      const r = at(j, income);
      expect(r.summary.effectiveIncomeTaxRate.toNumber()).toBeLessThanOrEqual(
        j.topEffectiveRate + 0.0001,
      );
    }
  });

  it("tax, contributions and take-home are never negative", () => {
    for (const income of incomes) {
      const s = at(j, income).summary;
      expect(s.incomeTax.isNegative()).toBe(false);
      expect(s.socialContributions.isNegative()).toBe(false);
      expect(s.takeHome.isNegative()).toBe(false);
    }
  });

  it("tax plus contributions plus take-home reconstruct the gross exactly", () => {
    for (const income of incomes) {
      const s = at(j, income).summary;
      const reconstructed = s.takeHome.plus(s.incomeTax).plus(s.socialContributions);
      expect(reconstructed.minus(s.annualGross).abs().toNumber()).toBeLessThan(0.005);
    }
  });

  it("the marginal rate is never negative and never absurd", () => {
    for (const income of incomes) {
      const m = at(j, income).summary.marginalRate.toNumber();
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(j.maxMarginal ?? 1);
    }
  });

  it("every step of the trace carries a formula, an output and a label", () => {
    const r = at(j, 60000);
    expect(r.steps.length).toBeGreaterThan(3);
    for (const step of r.steps) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.formula.length).toBeGreaterThan(0);
      expect(step.output).toBeDefined();
    }
  });

  it("the result is stamped with a ruleset version and its provenance", () => {
    const r = at(j, 60000);
    expect(r.rulesets.length).toBeGreaterThan(0);
    for (const stamp of r.rulesets) {
      expect(stamp.version.length).toBeGreaterThan(0);
      expect(stamp.provenance.source.length).toBeGreaterThan(0);
      expect(stamp.provenance.confidence).toBeDefined();
    }
  });
});

describe("property: every country is wired up consistently", () => {
  it("all twelve adapters are registered and self-consistent", () => {
    expect(COUNTRIES.length).toBe(12);
    for (const { code } of COUNTRIES) {
      const adapter = adapters[code];
      expect(adapter.country).toBe(code);
      expect(adapter.years().length).toBeGreaterThan(0);
      expect(adapter.regionLabel.length).toBeGreaterThan(0);
      expect(adapter.regionNote.length).toBeGreaterThan(0);
    }
  });

  it("every country declares at least one region and computes with defaults", () => {
    for (const { code } of COUNTRIES) {
      const adapter = adapters[code];
      for (const year of adapter.years()) {
        const regions = adapter.regions(year);
        expect(regions.length).toBeGreaterThan(0);
        for (const region of regions) {
          expect(adapter.fields(year, region.code).length).toBeGreaterThan(0);
          expect(() =>
            adapter.compute(input(code, region.code, {})),
          ).not.toThrow();
        }
      }
    }
  });

  it("every declared field has a label and explanatory help text", () => {
    for (const { code } of COUNTRIES) {
      const adapter = adapters[code];
      for (const year of adapter.years()) {
        for (const region of adapter.regions(year)) {
          for (const field of adapter.fields(year, region.code)) {
            expect(field.label.length).toBeGreaterThan(0);
            expect((field.help ?? "").length).toBeGreaterThan(10);
          }
        }
      }
    }
  });

  it("an unknown region is rejected rather than silently defaulted", () => {
    for (const { code } of COUNTRIES) {
      expect(() => adapters[code].compute(input(code, "narnia", {}))).toThrow();
    }
  });

  it("every ruleset declares what it does not model", () => {
    for (const { code } of COUNTRIES) {
      const adapter = adapters[code];
      const region = adapter.regions(adapter.years()[0])[0];
      const r = adapter.compute(input(code, region.code, {}));
      const hasOmissions = r.rulesets.some((s) => (s.omissions?.length ?? 0) > 0);
      expect(hasOmissions).toBe(true);
    }
  });
});
