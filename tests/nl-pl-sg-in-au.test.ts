import { describe, it, expect } from "vitest";
import { nlAdapter } from "../src/adapters/nl";
import { plAdapter } from "../src/adapters/pl";
import { sgAdapter } from "../src/adapters/sg";
import { inAdapter } from "../src/adapters/in";
import { auAdapter } from "../src/adapters/au";
import { input, perMonth, cents } from "./helpers";
import type { CalcResult, FieldValue } from "../src/engine/types";

const nl = (v: Record<string, FieldValue>) => nlAdapter.compute(input("NL", "nl", v));
const pl = (v: Record<string, FieldValue>) => plAdapter.compute(input("PL", "pl", v));
const sg = (v: Record<string, FieldValue>) => sgAdapter.compute(input("SG", "sg", v));
const ind = (v: Record<string, FieldValue>) => inAdapter.compute(input("IN", "in", v));
const au = (v: Record<string, FieldValue>) => auAdapter.compute(input("AU", "au", v));
const step = (r: CalcResult, id: string) => r.steps.find((s) => s.id === id)!;

describe("Netherlands - two credits, both tapering", () => {
  it("HAND-DERIVED: EUR 48,000 of salary", () => {
    // Bracket tax: 38,883 x 35.75% = 13,900.67 ; 9,117 x 37.56% = 3,424.35 => 17,325.02
    // Algemene heffingskorting: 3,115 - 6.398% x (48,000 - 29,736)
    //                          = 3,115 - 1,168.53 = 1,946.47
    // Arbeidskorting: 5,685 - 6.510% x (48,000 - 45,592) = 5,685 - 156.76 = 5,528.24
    // Tax: 17,325.02 - 1,946.47 - 5,528.24 = 9,850.31
    const r = nl({ grossMonthly: perMonth(4000) });
    expect(Number(step(r, "nl-4").output)).toBeCloseTo(17325.02, 2);
    expect(Number(step(r, "nl-5").output)).toBeCloseTo(1946.47, 2);
    expect(Number(step(r, "nl-6").output)).toBeCloseTo(5528.24, 2);
    expect(cents(r.summary.incomeTax)).toBeCloseTo(9850.31, 2);
  });

  it("the arbeidskorting builds up in three segments then falls away", () => {
    const at10k = Number(step(nl({ grossMonthly: perMonth(10000 / 12) }), "nl-6").output);
    const at25k = Number(step(nl({ grossMonthly: perMonth(25000 / 12) }), "nl-6").output);
    const atPeak = Number(step(nl({ grossMonthly: perMonth(45592 / 12) }), "nl-6").output);
    const at100k = Number(step(nl({ grossMonthly: perMonth(100000 / 12) }), "nl-6").output);
    expect(at10k).toBeLessThan(at25k);
    expect(at25k).toBeLessThan(atPeak);
    expect(atPeak).toBeCloseTo(5685, 0);
    expect(at100k).toBeLessThan(atPeak);
    // fully gone above 132,920
    expect(Number(step(nl({ grossMonthly: perMonth(140000 / 12) }), "nl-6").output)).toBe(0);
  });

  it("the real marginal rate far exceeds the headline 37.56% while both credits withdraw", () => {
    const marginal = nl({ grossMonthly: perMonth(50000 / 12) }).summary.marginalRate.toNumber();
    // 37.56% + 6.398% + 6.510% is about 50.5%
    expect(marginal).toBeGreaterThan(0.49);
    expect(marginal).toBeLessThan(0.52);
  });

  it("credits cannot make the tax negative", () => {
    const r = nl({ grossMonthly: perMonth(500) });
    expect(cents(r.summary.incomeTax)).toBe(0);
  });

  it("gifts count only above 1% of income and only up to 10%", () => {
    const r = nl({ grossMonthly: perMonth(4000), donations: "300" });
    // 1% of 48,000 is 480, so a 300 gift gives nothing
    expect(Number(step(r, "nl-2").inputs["gifts allowed"])).toBe(0);
    const bigger = nl({ grossMonthly: perMonth(4000), donations: "1000" });
    expect(Number(step(bigger, "nl-2").inputs["gifts allowed"])).toBe(520);
  });
});

describe("Poland - a reducing amount, and a health charge that is not deductible", () => {
  it("HAND-DERIVED: PLN 10,000 a month", () => {
    // ZUS: 11.26% x 120,000 = 13,512.00 ; sickness 2.45% x 120,000 = 2,940.00 => 16,452.00
    // Health: 9% x (120,000 - 16,452) = 9,319.32   (not deductible)
    // Costs: 250 x 12 = 3,000
    // Base: 120,000 - 16,452 - 3,000 = 100,548
    // Tax: 12% x 100,548 = 12,065.76, less 3,600 = 8,465.76 -> 8,466 (whole zloty)
    const r = pl({ grossMonthly: perMonth(10000) });
    expect(Number(step(r, "pl-2").output)).toBeCloseTo(16452, 2);
    expect(Number(step(r, "pl-3").output)).toBeCloseTo(9319.32, 2);
    expect(Number(step(r, "pl-6").output)).toBe(100548);
    expect(cents(r.summary.incomeTax)).toBe(8466);
  });

  it("the health contribution is excluded from the tax base on purpose", () => {
    const r = pl({ grossMonthly: perMonth(10000) });
    const base = Number(step(r, "pl-6").output);
    const health = Number(step(r, "pl-3").output);
    // If health were deductible the base would be about 9,319 lower.
    expect(base).toBeCloseTo(100548, 0);
    expect(base + health).toBeGreaterThan(base);
    expect(step(r, "pl-6").note).toContain("not deductible");
  });

  it("the tax-reducing amount makes the first PLN 30,000 effectively free", () => {
    const r = pl({ grossMonthly: perMonth(30000 / 12) });
    // Base is below 30,000 after ZUS and costs, so 12% of it is under 3,600.
    expect(cents(r.summary.incomeTax)).toBe(0);
  });

  it("the under-26 exemption removes tax but not contributions", () => {
    const ordinary = pl({ grossMonthly: perMonth(5000) });
    const young = pl({ grossMonthly: perMonth(5000), under26: true });
    expect(cents(young.summary.incomeTax)).toBe(0);
    expect(cents(young.summary.socialContributions)).toBe(
      cents(ordinary.summary.socialContributions),
    );
  });

  it("the under-26 exemption stops at PLN 85,528, and contributions on the exempt part are not deductible", () => {
    // At 120,000 the exemption covers 85,528, leaving 34,472 taxable. Only the
    // ZUS and costs attributable to that taxable share may be deducted, and the
    // remaining base is still small enough for the 3,600 reducing amount to
    // wipe out the tax entirely.
    const atLimit = pl({ grossMonthly: perMonth(10000), under26: true });
    expect(atLimit.warnings.join(" ")).toContain("85");
    expect(Number(step(atLimit, "pl-5").inputs["taxable share"])).toBeCloseTo(0.2873, 3);
    expect(cents(atLimit.summary.incomeTax)).toBe(0);

    // Well above the limit the exemption runs out and tax becomes payable.
    const higher = pl({ grossMonthly: perMonth(20000), under26: true });
    expect(cents(higher.summary.incomeTax)).toBeGreaterThan(0);
    // and a young worker still pays less than an older colleague on the same pay
    expect(cents(higher.summary.incomeTax)).toBeLessThan(
      cents(pl({ grossMonthly: perMonth(20000) }).summary.incomeTax),
    );
  });

  it("the pension cap is annual, so it bites part-way through the year", () => {
    const r = pl({ grossMonthly: perMonth(30000) });
    // 360,000 of pay, capped at 282,600 for pension and disability
    // 11.26% x 282,600 = 31,820.76 ; sickness 2.45% x 360,000 = 8,820
    expect(Number(step(r, "pl-2").inputs["pension and disability"])).toBeCloseTo(31820.76, 2);
    expect(r.warnings.join(" ")).toContain("annual pension and disability cap");
  });

  it("the solidarity levy applies only above PLN 1,000,000", () => {
    const below = pl({ grossMonthly: perMonth(50000) });
    const above = pl({ grossMonthly: perMonth(120000) });
    expect(Number(step(below, "pl-9").output)).toBe(0);
    expect(Number(step(above, "pl-9").output)).toBeGreaterThan(0);
  });
});

describe("Singapore - one cap over all reliefs", () => {
  it("HAND-DERIVED: SGD 6,000 a month", () => {
    // CPF: 20% x 6,000 x 12 = 14,400
    // Reliefs: 14,400 + 1,000 earned income = 15,400 (under the 80,000 cap)
    // Chargeable: 72,000 - 15,400 = 56,600
    // Tax: 550 (first 40,000) + 7% x 16,600 = 550 + 1,162 = 1,712
    const r = sg({ grossMonthly: perMonth(6000) });
    expect(cents(r.summary.socialContributions)).toBe(14400);
    expect(Number(step(r, "sg-3").output)).toBe(15400);
    expect(Number(step(r, "sg-5").output)).toBe(56600);
    expect(cents(r.summary.incomeTax)).toBe(1712);
  });

  it("CPF stops at the monthly Ordinary Wage ceiling", () => {
    // 20% x 8,000 x 12 = 19,200 whatever the salary above that
    expect(cents(sg({ grossMonthly: perMonth(8000) }).summary.socialContributions)).toBe(19200);
    expect(cents(sg({ grossMonthly: perMonth(40000) }).summary.socialContributions)).toBe(19200);
  });

  it("the SGD 80,000 cap truncates the SUM of reliefs, not each one", () => {
    const r = sg({ grossMonthly: perMonth(20000), otherReliefs: "100000" });
    expect(Number(step(r, "sg-3").output)).toBe(80000);
    expect(r.warnings.join(" ")).toContain("worth nothing");

    // Another relief on top changes nothing at all.
    const more = sg({ grossMonthly: perMonth(20000), otherReliefs: "120000" });
    expect(cents(more.summary.incomeTax)).toBe(cents(r.summary.incomeTax));
  });

  it("donations are deducted at 250% and sit outside the cap", () => {
    const r = sg({ grossMonthly: perMonth(6000), donations: "1000" });
    expect(Number(step(r, "sg-4").output)).toBe(2500);
    expect(Number(step(r, "sg-5").output)).toBe(56600 - 2500);
  });

  it("a foreign employee pays no CPF and so gets no CPF relief", () => {
    const resident = sg({ grossMonthly: perMonth(6000) });
    const foreign = sg({ grossMonthly: perMonth(6000), citizen: false });
    expect(cents(foreign.summary.socialContributions)).toBe(0);
    expect(cents(foreign.summary.incomeTax)).toBeGreaterThan(cents(resident.summary.incomeTax));
  });

  it("the first SGD 20,000 of chargeable income is untaxed", () => {
    expect(cents(sg({ grossMonthly: perMonth(1500) }).summary.incomeTax)).toBe(0);
  });
});

describe("India - rebate, surcharge and cess, each stacked on the last", () => {
  it("a salary of INR 12,75,000 is exactly tax free under the new regime", () => {
    // 12,75,000 - 75,000 standard deduction = 12,00,000, which the s. 87A
    // rebate wipes out entirely.
    const r = ind({ grossMonthly: perMonth(1275000 / 12) });
    expect(Number(step(r, "in-2").output)).toBe(1200000);
    expect(cents(r.summary.incomeTax)).toBe(0);
  });

  it("HAND-DERIVED: INR 20,00,000 of salary", () => {
    // Total income 19,25,000
    // Slabs: 4L nil | 4L x 5% = 20,000 | 4L x 10% = 40,000 | 4L x 15% = 60,000
    //        | 3.25L x 20% = 65,000  => 1,85,000
    // No rebate, no surcharge. Cess 4% = 7,400. Total 1,92,400.
    const r = ind({ grossMonthly: perMonth(2000000 / 12) });
    expect(Number(step(r, "in-3").output)).toBe(185000);
    expect(Number(step(r, "in-7").output)).toBe(7400);
    expect(cents(r.summary.incomeTax)).toBe(192400);
  });

  it("marginal relief stops the rebate cliff from costing more than the extra income", () => {
    const atLimit = ind({ grossMonthly: perMonth(1275000 / 12) });
    const justOver = ind({ grossMonthly: perMonth(1285000 / 12) });
    // Without relief, tax on a total income of 12,10,000 would be 61,500 plus
    // cess, so INR 10,000 of extra salary would cost INR 63,960. Marginal
    // relief caps the income tax itself at the 10,000 of excess income; the 4%
    // cess is then charged on that, giving 10,400.
    expect(cents(atLimit.summary.incomeTax)).toBe(0);
    expect(cents(justOver.summary.incomeTax)).toBe(10400);
    expect(cents(justOver.summary.incomeTax)).toBeLessThan(63960);
    expect(justOver.warnings.join(" ")).toContain("marginal relief");
  });

  it("cess is charged on tax plus surcharge, after the rebate", () => {
    const r = ind({ grossMonthly: perMonth(6000000 / 12) });
    const tax = Number(step(r, "in-5").output);
    const surcharge = Number(step(r, "in-6").output);
    const cess = Number(step(r, "in-7").output);
    expect(surcharge).toBeGreaterThan(0);
    expect(cess).toBeCloseTo((tax + surcharge) * 0.04, 2);
  });

  it("the final liability is rounded to the nearest ten rupees", () => {
    for (const salary of [1500000, 2345678, 5500000]) {
      const tax = ind({ grossMonthly: perMonth(salary / 12) }).summary.incomeTax.toNumber();
      expect(tax % 10).toBe(0);
    }
  });

  it("employee provident fund reduces take-home pay but not tax", () => {
    const without = ind({ grossMonthly: perMonth(2000000 / 12) });
    const withEpf = ind({ grossMonthly: perMonth(2000000 / 12), epf: "120000" });
    expect(cents(withEpf.summary.incomeTax)).toBe(cents(without.summary.incomeTax));
    expect(cents(withEpf.summary.takeHome)).toBe(cents(without.summary.takeHome) - 120000);
  });

  it("employer NPS is one of the few deductions that survives the new regime", () => {
    const without = ind({ grossMonthly: perMonth(2000000 / 12) });
    const withNps = ind({ grossMonthly: perMonth(2000000 / 12), employerNps: "200000" });
    expect(cents(withNps.summary.incomeTax)).toBeLessThan(cents(without.summary.incomeTax));
  });
});

describe("Australia - a shaded levy and a non-refundable offset", () => {
  it("HAND-DERIVED: AUD 90,000 of salary", () => {
    // Tax: 26,800 x 15% = 4,020 ; 45,000 x 30% = 13,500 => 17,520
    // LITO: 700 - 5% x 7,500 - 1.5% x 45,000 = 700 - 375 - 675, floored at 0
    // Medicare: 2% x 90,000 = 1,800
    // Total: 17,520 + 1,800 = 19,320
    const r = au({ grossMonthly: perMonth(7500) });
    expect(Number(step(r, "au-4").output)).toBe(17520);
    expect(Number(step(r, "au-5").output)).toBe(0);
    expect(Number(step(r, "au-7").output)).toBe(1800);
    expect(cents(r.summary.incomeTax)).toBe(19320);
  });

  it("the Medicare levy is nil, then shaded in, then charged on the whole income", () => {
    expect(Number(step(au({ grossMonthly: perMonth(27000 / 12) }), "au-7").output)).toBe(0);

    // In the shade-in range only 10 cents in the dollar of the excess is charged.
    const shaded = au({ grossMonthly: perMonth(30000 / 12) });
    expect(Number(step(shaded, "au-7").output)).toBeCloseTo((30000 - 28011) * 0.1, 2);
    expect(shaded.warnings.join(" ")).toContain("shade-in");

    // Above the ceiling the full 2% applies to the WHOLE taxable income.
    const full = au({ grossMonthly: perMonth(40000 / 12) });
    expect(Number(step(full, "au-7").output)).toBeCloseTo(800, 2);
  });

  it("the low income tax offset is non-refundable", () => {
    // At 20,000 the tax is 15% x 1,800 = 270, less than the 700 offset,
    // so the offset is limited to the tax and no refund is created.
    const r = au({ grossMonthly: perMonth(20000 / 12) });
    expect(Number(step(r, "au-4").output)).toBe(270);
    expect(Number(step(r, "au-5").output)).toBe(270);
    expect(Number(step(r, "au-6").output)).toBe(0);
  });

  it("the offset withdrawal lifts the marginal rate above the bracket rate", () => {
    // At 40,000: 15% bracket + 2% Medicare levy + 5% of offset withdrawn = 22%
    expect(au({ grossMonthly: perMonth(40000 / 12) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.22,
      3,
    );
    // At 50,000: 30% bracket + 2% levy + the slower 1.5% withdrawal = 33.5%
    expect(au({ grossMonthly: perMonth(50000 / 12) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.335,
      3,
    );
    // Past 66,667 the offset is gone and only the bracket and levy remain.
    expect(au({ grossMonthly: perMonth(80000 / 12) }).summary.marginalRate.toNumber()).toBeCloseTo(
      0.32,
      3,
    );
  });

  it("the first AUD 18,200 is tax free", () => {
    expect(cents(au({ grossMonthly: perMonth(18200 / 12) }).summary.incomeTax)).toBe(0);
  });

  it("work-related deductions reduce taxable income", () => {
    const without = au({ grossMonthly: perMonth(7500) });
    const withDeductions = au({ grossMonthly: perMonth(7500), workExpenses: "3000" });
    expect(Number(step(withDeductions, "au-3").output)).toBe(87000);
    expect(cents(withDeductions.summary.incomeTax)).toBeLessThan(cents(without.summary.incomeTax));
  });
});
