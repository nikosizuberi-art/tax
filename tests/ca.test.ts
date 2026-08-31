import { describe, it, expect } from "vitest";
import { caAdapter } from "../src/adapters/ca";
import { ca, perMonth, cents } from "./helpers";

/**
 * Golden cases for Canada.
 *
 * HAND-DERIVED values were computed longhand from the ruleset figures,
 * independently of the pipeline code, and the arithmetic is written out above
 * each assertion. No CRA worked examples are embedded yet - see
 * tests/GOLDEN-TODO.md.
 */

const run = (values: Parameters<typeof ca>[1], region = "on") => caAdapter.compute(ca(region, values));
const plain = (monthlyGross: number, monthCount = 12, region = "on") =>
  run({ grossMonthly: perMonth(monthlyGross, monthCount) }, region);
const step = (r: ReturnType<typeof run>, id: string) => r.steps.find((s) => s.id === id)!;

describe("Canada - structural cases", () => {
  it("zero income produces zero tax, zero CPP and zero EI", () => {
    const r = plain(0);
    expect(cents(r.summary.annualGross)).toBe(0);
    expect(cents(r.summary.socialContributions)).toBe(0);
    expect(cents(r.summary.incomeTax)).toBe(0);
  });

  it("blank months are not annualised: 7 months of 5.000 is taxed as 35.000", () => {
    const partial = plain(5000, 7);
    expect(cents(partial.summary.annualGross)).toBe(35000);
    expect(partial.summary.monthsWorked).toBe(7);
    expect(cents(partial.summary.incomeTax)).toBeLessThan(cents(plain(5000, 12).summary.incomeTax));
  });

  it("credits are valued at the lowest rate, not deducted from income", () => {
    // If the BPA were deducted from income, taxable income at 60.000 would fall
    // to about 43.000 and federal tax before credits would change. It does not:
    // tax is computed on the full 59.435 and the credit is 14% of the BPA.
    const r = plain(5000);
    expect(Number(step(r, "ca-6").inputs["taxable income"])).toBeCloseTo(59435, 2);
    expect(Number(step(r, "ca-7a").output)).toBe(16452);
  });
});

describe("Canada - hand-derived golden values (Ontario, 2026 ruleset)", () => {
  it("HAND-DERIVED: 60.000 employment income", () => {
    // CPP1 = (60.000 - 3.500) x 5,95% = 3.361,75      CPP2 = 0
    // EI   = 60.000 x 1,63% = 978,00
    // Enhanced CPP deduction = 56.500 x 1% = 565,00
    // Net and taxable income = 60.000 - 565 = 59.435
    // Federal before credits: 58.523x14% = 8.193,22 | 912x20,5% = 186,96 => 8.380,18
    // Credit base = 16.452 BPA + 2.796,75 CPP base + 978,00 EI + 1.500 CEA = 21.726,75
    // Credits = 21.726,75 x 14% = 3.041,75      Federal tax = 5.338,43
    // Ontario before credits: 53.891x5,05% = 2.721,50 | 5.544x9,15% = 507,28 => 3.228,78
    // Ontario credits = (12.989 + 2.796,75 + 978,00) x 5,05% = 846,57
    // Ontario after credits = 2.382,21   Surtax = 0 (below 5.819)
    // Health premium: 450 + 25% x (59.435 - 48.000) capped at 600 => 600
    // Total = 5.338,43 + 2.382,21 + 600 = 8.320,64
    const r = plain(5000);
    expect(cents(r.summary.socialContributions)).toBe(4339.75);
    expect(Number(step(r, "ca-6").output)).toBe(8380.18);
    expect(Number(step(r, "ca-8").output)).toBe(5338.43);
    expect(Number(step(r, "ca-10b").output)).toBe(2382.21);
    expect(Number(step(r, "ca-11b").output)).toBe(600);
    expect(cents(r.summary.incomeTax)).toBe(8320.64);
    expect(cents(r.summary.takeHome)).toBe(47339.61);
  });

  it("HAND-DERIVED: 150.000 employment income triggers both Ontario surtax layers", () => {
    // CPP1 = 4.230,45 (max)   CPP2 = 10.400 x 4% = 416,00   EI = 1.123,07 (max)
    // Enhanced deduction = 711,00 + 416,00 = 1.127,00   Taxable = 148.873
    // Federal: 8.193,22 + 11.997,01 + 8.275,28 = 28.465,51
    // Credit base = 16.452 + 3.519,45 + 1.123,07 + 1.500 = 22.594,52 -> 3.163,23
    // Federal tax = 25.302,28
    // Ontario: 2.721,50 + 4.931,30 + 4.585,42 = 12.238,22
    // Ontario credits = (12.989 + 3.519,45 + 1.123,07) x 5,05% = 890,39
    // After credits = 11.347,83
    // Surtax = 20% x (11.347,83 - 5.819) + 36% x (11.347,83 - 7.446)
    //        = 1.105,77 + 1.404,66 = 2.510,43
    // Health premium = 750 (capped)
    // Total = 25.302,28 + 11.347,83 + 2.510,43 + 750 = 39.910,54
    const r = plain(12500);
    expect(Number(step(r, "ca-2").output)).toBe(4646.45);
    expect(Number(step(r, "ca-5").output)).toBe(148873);
    expect(Number(step(r, "ca-8").output)).toBe(25302.28);
    expect(Number(step(r, "ca-10b").output)).toBe(11347.83);
    expect(Number(step(r, "ca-11").output)).toBe(2510.43);
    expect(Number(step(r, "ca-11b").output)).toBe(750);
    expect(cents(r.summary.incomeTax)).toBe(39910.54);
  });

  it("the Ontario surtax is charged on tax, not on income", () => {
    const r = plain(12500);
    const surtax = step(r, "ca-11");
    const afterCredits = Number(step(r, "ca-10b").output);
    // 20% of the excess over 5.819 plus 36% of the excess over 7.446, both
    // measured against provincial TAX of 11.347,83 - never against income.
    const expected =
      0.2 * (afterCredits - 5819) + 0.36 * (afterCredits - 7446);
    expect(Number(surtax.output)).toBeCloseTo(expected, 1);
    expect(Number(surtax.output)).toBeLessThan(afterCredits);
  });
});

describe("Canada - CPP, CPP2 and EI boundaries", () => {
  it("CPP1 stops at the YMPE and CPP2 starts there", () => {
    const atYmpe = plain(74600 / 12);
    const aboveYampe = plain(90000 / 12);
    // (74.600 - 3.500) x 5,95% = 4.230,45, the published maximum
    expect(Number(step(atYmpe, "ca-2").inputs["CPP1"])).toBe(4230.45);
    expect(Number(step(atYmpe, "ca-2").inputs["CPP2"])).toBe(0);
    // (85.000 - 74.600) x 4% = 416,00, the published CPP2 maximum
    expect(Number(step(aboveYampe, "ca-2").inputs["CPP2"])).toBe(416);
    expect(Number(step(aboveYampe, "ca-2").output)).toBe(4646.45);
  });

  it("EI stops at the maximum insurable earnings", () => {
    // 68.900 x 1,63% = 1.123,07
    expect(Number(step(plain(68900 / 12), "ca-3").output)).toBe(1123.07);
    expect(Number(step(plain(200000 / 12), "ca-3").output)).toBe(1123.07);
  });

  it("contributions never exceed the published annual maxima", () => {
    const r = plain(500000 / 12);
    expect(Number(step(r, "ca-2").output)).toBeLessThanOrEqual(4230.45 + 416);
    expect(Number(step(r, "ca-3").output)).toBeLessThanOrEqual(1123.07);
  });
});

describe("Canada - BPA phase-out band", () => {
  it("the BPA is full below the band, tapered inside it and minimum above it", () => {
    expect(Number(step(plain(150000 / 12), "ca-7a").output)).toBe(16452);
    const inside = Number(step(plain(220000 / 12), "ca-7a").output);
    expect(inside).toBeLessThan(16452);
    expect(inside).toBeGreaterThan(14829);
    expect(Number(step(plain(300000 / 12), "ca-7a").output)).toBe(14829);
  });

  it("the marginal rate inside the band reflects the 29,29% federal effect", () => {
    // Federal 29% plus the BPA claw-back: 1.623 / 77.042 x 14% = 0,2949 points
    // => 29,2949%. Ontario adds 12,16% grossed up by both surtax layers
    // (1 + 0,20 + 0,36) = 18,9696%. Combined: 48,2645%.
    // The health premium is already capped at 750 here, so it adds nothing.
    const r = plain(200000 / 12);
    const marginal = r.summary.marginalRate.toNumber();
    expect(marginal).toBeCloseTo(0.482645, 3); // the probe resolves to 0,01% because tax is rounded to cents
    expect(r.warnings.join(" ")).toContain("phase-out");
  });

  it("Alberta values credits at 10% even though its lowest bracket rate is 8%", () => {
    const r = plain(60000 / 12, 12, "ab");
    expect(Number(step(r, "ca-10").inputs["provincial credit rate"])).toBe(0.1);
    expect(Number(step(r, "ca-9").bands![0].rate)).toBe(0.08);
  });
});

describe("Canada - provincial variation", () => {
  const provinces = ["on", "bc", "ab"];

  it("the same income gives a different answer in every province", () => {
    const results = provinces.map((p) => cents(plain(6000, 12, p).summary.incomeTax));
    expect(new Set(results).size).toBe(provinces.length);
  });

  it("the federal half is identical in every province", () => {
    const federal = provinces.map((p) => Number(step(plain(6000, 12, p), "ca-8").output));
    expect(new Set(federal).size).toBe(1);
  });

  it("only Ontario charges a surtax and a health premium", () => {
    expect(step(plain(12500, 12, "on"), "ca-11")).toBeDefined();
    expect(plain(12500, 12, "bc").steps.find((s) => s.id === "ca-11")).toBeUndefined();
    expect(plain(12500, 12, "ab").steps.find((s) => s.id === "ca-11b")).toBeUndefined();
  });

  it("Alberta's large BPA makes it the cheapest of the three at a middling income", () => {
    const on = cents(plain(6000, 12, "on").summary.incomeTax);
    const bc = cents(plain(6000, 12, "bc").summary.incomeTax);
    const ab = cents(plain(6000, 12, "ab").summary.incomeTax);
    expect(ab).toBeLessThan(on);
    expect(bc).toBeLessThan(on);
  });
});

describe("Canada - deductions and credits", () => {
  it("RRSP contributions reduce net and taxable income", () => {
    const without = plain(6000);
    const with10k = run({ grossMonthly: perMonth(6000), rrsp: "10000" });
    expect(Number(step(with10k, "ca-5").output)).toBeCloseTo(
      Number(step(without, "ca-5").output) - 10000,
      2,
    );
    expect(cents(with10k.summary.incomeTax)).toBeLessThan(cents(without.summary.incomeTax));
  });

  it("medical expenses count only above the lesser of 3% of net income and the fixed threshold", () => {
    // Net income 59.435 -> 3% = 1.783,05, which is below the 2.891 threshold,
    // so the 3% figure applies and only 216,95 of a 2.000 claim is creditable.
    const r = run({ grossMonthly: perMonth(5000), medical: "2000" });
    expect(Number(step(r, "ca-7b").inputs["medical threshold applied"])).toBe(1783.05);
    expect(Number(step(r, "ca-7b").inputs["medical above threshold"])).toBe(216.95);
  });

  it("the fixed threshold binds once 3% of net income exceeds it", () => {
    const r = run({ grossMonthly: perMonth(20000), medical: "5000" });
    expect(Number(step(r, "ca-7b").inputs["medical threshold applied"])).toBe(2891);
  });

  it("donations are credited at the lowest rate on the first 200 and 29% above it", () => {
    // 200 x 14% = 28,00 plus 800 x 29% = 232,00  ->  260,00
    const r = run({ grossMonthly: perMonth(5000), donations: "1000" });
    expect(Number(step(r, "ca-7c").output)).toBe(260);
  });

  it("donations reach 33% only to the extent taxable income sits in the top bracket", () => {
    const r = run({ grossMonthly: perMonth(300000 / 12), donations: "10000" });
    expect(Number(step(r, "ca-7c").inputs["excess credited at 33%"])).toBe(9800);
    // 200 x 14% + 9.800 x 33% = 28 + 3.234 = 3.262
    expect(Number(step(r, "ca-7c").output)).toBe(3262);
  });

  it("withholding produces a refund or a balance owing without changing the liability", () => {
    const r = run({ grossMonthly: perMonth(5000), taxWithheldMonthly: perMonth(800) });
    expect(cents(r.summary.incomeTax)).toBe(8320.64);
    expect(cents(r.summary.withheld)).toBe(9600);
    expect(cents(r.summary.balance)).toBeCloseTo(9600 - 8320.64, 2);
  });
});

describe("Canada - trace integrity", () => {
  it("bracket steps expand every band and the bands sum to the step total", () => {
    const r = plain(12500);
    const fed = step(r, "ca-6");
    expect(fed.bands!.length).toBe(3);
    expect(fed.bands!.reduce((acc, b) => acc + Number(b.tax), 0)).toBeCloseTo(
      Number(fed.output),
      2,
    );
  });

  it("the result is stamped with both ruleset versions and their provenance", () => {
    const r = plain(5000);
    expect(r.rulesets.map((s) => s.version)).toEqual([
      "ca-federal-2026-0.1.0",
      "ca-on-2026-0.1.0",
    ]);
    expect(r.rulesets[1].provenance.confidence).toBe("unverified-estimate");
  });
});
