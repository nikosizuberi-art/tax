import { describe, it, expect } from "vitest";
import { compute } from "../src/adapters";
import { input, perMonth, cents } from "./helpers";
import type { CalcResult, CountryCode, FieldValue } from "../src/engine/types";

/**
 * Golden cases for the eighteen jurisdictions added in the second pass.
 *
 * HAND-DERIVED values were computed longhand from the ruleset figures,
 * independently of the pipeline code, with the arithmetic written out above
 * each assertion. As with the first wave, none of these come from a tax
 * authority's own worked example - see tests/GOLDEN-TODO.md.
 */

const run = (c: CountryCode, region: string, values: Record<string, FieldValue>) =>
  compute(input(c, region, values));
const step = (r: CalcResult, id: string) => r.steps.find((s) => s.id === id)!;
const monthly = (annual: number) => perMonth(annual / 12);

describe("United States - a second, independent state computation", () => {
  it("HAND-DERIVED: USD 120,000 in California", () => {
    // FICA: 6.2% x 120,000 = 7,440.00 (under the wage base) + 1.45% x 120,000
    //       = 1,740.00, no additional Medicare below 200,000 => 9,180.00
    // Federal taxable: 120,000 - 16,100 = 103,900
    //   12,400x10% = 1,240 | 38,000x12% = 4,560 | 53,500x22% = 11,770 => 17,570
    // California base: 120,000 - 5,540 = 114,460
    //   110.79 + 303.70 + 607.52 + 965.40 + 1,214.56 + 3,881.45 = 7,083.42
    //   less the 153 exemption credit => 6,930.42
    // Total 24,500.42
    const r = run("US", "ca", { grossMonthly: monthly(120000) });
    expect(cents(r.summary.socialContributions)).toBe(9180);
    expect(Number(step(r, "us-5").output)).toBe(17570);
    expect(Number(step(r, "us-6").output)).toBe(6930.42);
    expect(cents(r.summary.incomeTax)).toBe(24500.42);
    expect(cents(r.summary.takeHome)).toBe(86319.58);
  });

  it("Texas has no state computation at all, so only the federal figure remains", () => {
    const tx = run("US", "tx", { grossMonthly: monthly(120000) });
    expect(Number(step(tx, "us-6").output)).toBe(0);
    expect(cents(tx.summary.incomeTax)).toBe(17570);
    expect(step(tx, "us-6").formula).toContain("no individual income tax");
  });

  it("the same salary costs materially more in California than in Illinois or Texas", () => {
    const ca = cents(run("US", "ca", { grossMonthly: monthly(120000) }).summary.incomeTax);
    const il = cents(run("US", "il", { grossMonthly: monthly(120000) }).summary.incomeTax);
    const tx = cents(run("US", "tx", { grossMonthly: monthly(120000) }).summary.incomeTax);
    expect(ca).toBeGreaterThan(il);
    expect(il).toBeGreaterThan(tx);
  });

  it("Social Security stops at the wage base but Medicare does not", () => {
    const under = run("US", "tx", { grossMonthly: monthly(176100) });
    const over = run("US", "tx", { grossMonthly: monthly(300000) });
    // 6.2% x 176,100 = 10,918.20 in both cases
    expect(Number(step(under, "us-2").inputs["Social Security"])).toBe(10918.2);
    expect(Number(step(over, "us-2").inputs["Social Security"])).toBe(10918.2);
    // Medicare keeps climbing, and the extra 0.9% kicks in above 200,000
    expect(Number(step(over, "us-2").inputs["Medicare"])).toBe(4350);
    expect(Number(step(over, "us-2").inputs["additional Medicare"])).toBe(900);
    expect(over.warnings.join(" ")).toContain("wage base");
  });

  it("a 401(k) contribution reduces income tax but not FICA", () => {
    const without = run("US", "tx", { grossMonthly: monthly(120000) });
    const with401k = run("US", "tx", { grossMonthly: monthly(120000), pretax401k: "20000" });
    expect(cents(with401k.summary.socialContributions)).toBe(
      cents(without.summary.socialContributions),
    );
    expect(cents(with401k.summary.incomeTax)).toBeLessThan(cents(without.summary.incomeTax));
  });
});

describe("France - the quotient familial", () => {
  it("HAND-DERIVED: EUR 50,000, one part", () => {
    // CSG/CRDS assiette 49,125; CSG 4,519.50 (6.8 points deductible = 3,340.50);
    // CRDS 245.63; other contributions 5,500 => 10,265.13
    // Net before abattement 41,159.50; abattement 10% = 4,115.95
    // Net imposable 37,043.55
    // Bareme: 17,979x11% = 1,977.69 | 7,464.55x30% = 2,239.37 => 4,217.06
    // Rounded to the euro: 4,217
    const r = run("FR", "fr", { grossMonthly: monthly(50000), parts: "1" });
    expect(cents(r.summary.socialContributions)).toBeCloseTo(10265.13, 2);
    expect(Number(step(r, "fr-3").output)).toBeCloseTo(37043.55, 2);
    expect(cents(r.summary.incomeTax)).toBe(4217);
  });

  it("family parts divide, tax, then multiply back - and the saving is capped", () => {
    const single = run("FR", "fr", { grossMonthly: monthly(90000), parts: "1" });
    const withTwo = run("FR", "fr", { grossMonthly: monthly(90000), parts: "2" });
    expect(cents(withTwo.summary.incomeTax)).toBeLessThan(cents(single.summary.incomeTax));
    // Two parts is two half-parts above one, so the saving is capped at 2 x 1,807
    const saving = cents(single.summary.incomeTax) - cents(withTwo.summary.incomeTax);
    expect(saving).toBeLessThanOrEqual(2 * 1807 + 1);
    expect(withTwo.warnings.join(" ")).toContain("capped");
  });

  it("the decote suppresses tax at the bottom of the scale", () => {
    const r = run("FR", "fr", { grossMonthly: monthly(20000), parts: "1" });
    expect(Number(step(r, "fr-6").inputs["decote"])).toBeGreaterThan(0);
  });

  it("only 6.8 of the 9.2 CSG points are deductible", () => {
    const r = run("FR", "fr", { grossMonthly: monthly(50000), parts: "1" });
    const csg = Number(step(r, "fr-2").inputs["CSG"]);
    const deductible = Number(step(r, "fr-2").inputs["dont CSG deductible"]);
    expect(deductible).toBeLessThan(csg);
    expect(deductible / csg).toBeCloseTo(6.8 / 9.2, 4);
  });
});

describe("Italy - a credit that tapers, and a transfer that is paid out", () => {
  it("the employment credit is worth 1,955 at low income and nothing at 50,000", () => {
    expect(Number(step(run("IT", "lazio-roma", { grossMonthly: monthly(14000) }), "it-5").inputs["detrazione spettante"])).toBe(1955);
    expect(Number(step(run("IT", "lazio-roma", { grossMonthly: monthly(60000) }), "it-5").inputs["detrazione spettante"])).toBe(0);
  });

  it("the trattamento integrativo is PAID, so net tax can go below zero", () => {
    const r = run("IT", "lombardia-milano", { grossMonthly: monthly(13000) });
    expect(Number(step(r, "it-7").output)).toBe(1200);
    expect(cents(r.summary.incomeTax)).toBeLessThan(0);
  });

  it("the regional and municipal surcharges are due even when IRPEF is nil", () => {
    // At EUR 9,000 the employment credit of 1,955 exceeds the gross IRPEF of
    // about 1,880, so IRPEF nets to zero - but both surcharges are charged on
    // the whole income regardless and are still payable.
    const r = run("IT", "lazio-roma", { grossMonthly: monthly(9000) });
    expect(Number(step(r, "it-6").output)).toBe(0);
    expect(Number(step(r, "it-8").output)).toBeGreaterThan(0);
  });

  it("Rome costs more than Milan on the same salary", () => {
    const roma = cents(run("IT", "lazio-roma", { grossMonthly: monthly(40000) }).summary.incomeTax);
    const milano = cents(
      run("IT", "lombardia-milano", { grossMonthly: monthly(40000) }).summary.incomeTax,
    );
    expect(roma).toBeGreaterThan(milano);
  });
});

describe("Ireland - three charges over three bases", () => {
  it("HAND-DERIVED: EUR 60,000", () => {
    // PRSI: 9 months at 4.2% of 5,000 = 1,890.00 plus 3 at 4.35% = 652.50 => 2,542.50
    // USC: 12,012x0.5% = 60.06 | 16,688x2% = 333.76 | 31,300x3% = 939.00 => 1,332.82
    // Income tax: 44,000x20% = 8,800 | 16,000x40% = 6,400 => 15,200, less
    //             3,900 of credits => 11,300
    // Income tax plus USC = 12,632.82
    const r = run("IE", "ie", { grossMonthly: perMonth(5000) });
    expect(cents(r.summary.socialContributions)).toBe(2542.5);
    expect(Number(step(r, "ie-3").output)).toBe(1332.82);
    expect(Number(step(r, "ie-7").output)).toBe(11300);
    expect(cents(r.summary.incomeTax)).toBe(12632.82);
  });

  it("the PRSI rate rises on 1 October, so the last quarter costs more", () => {
    const r = run("IE", "ie", { grossMonthly: perMonth(5000) });
    expect(Number(step(r, "ie-2").inputs["rate to 30 September"])).toBe(0.042);
    expect(Number(step(r, "ie-2").inputs["rate from 1 October"])).toBe(0.0435);
  });

  it("USC is a cliff, not a taper, at the exemption threshold", () => {
    const under = run("IE", "ie", { grossMonthly: monthly(12900) });
    const over = run("IE", "ie", { grossMonthly: monthly(13100) });
    expect(Number(step(under, "ie-3").output)).toBe(0);
    // Once over the threshold the whole income is charged, not just the excess
    expect(Number(step(over, "ie-3").output)).toBeGreaterThan(80);
  });

  it("a pension contribution reduces income tax but neither USC nor PRSI", () => {
    const without = run("IE", "ie", { grossMonthly: perMonth(5000) });
    const withPension = run("IE", "ie", { grossMonthly: perMonth(5000), pension: "6000" });
    expect(Number(step(withPension, "ie-3").output)).toBe(Number(step(without, "ie-3").output));
    expect(cents(withPension.summary.socialContributions)).toBe(
      cents(without.summary.socialContributions),
    );
    expect(Number(step(withPension, "ie-7").output)).toBeLessThan(
      Number(step(without, "ie-7").output),
    );
  });
});

describe("Portugal, Austria, Czechia", () => {
  it("HAND-DERIVED Portugal: EUR 30,000", () => {
    // SS 11% = 3,300; specific deduction max(3,300, 4,500) = 4,500
    // Taxable 25,500, which falls in the 31.1% row with 3,092.77 to abate
    // 25,500 x 31.1% = 7,930.50 - 3,092.77 = 4,837.73
    const r = run("PT", "continente", { grossMonthly: monthly(30000) });
    expect(cents(r.summary.socialContributions)).toBe(3300);
    expect(Number(step(r, "pt-3").output)).toBe(25500);
    expect(cents(r.summary.incomeTax)).toBe(4837.73);
  });

  it("HAND-DERIVED Austria: EUR 48,000 salary plus EUR 8,000 of 13th and 14th pay", () => {
    // SV on salary: 4,000 x 18.07% x 12 = 8,673.60; on special pay 1,445.60
    // Taxable salary 48,000 - 8,673.60 - 132 = 39,194.40
    //   8,453x20% = 1,690.60 | 14,466x30% = 4,339.80 | 2,736.40x40% = 1,094.56
    //   => 7,124.96, less the 487 Verkehrsabsetzbetrag => 6,637.96
    // Special pay: (8,000 - 1,445.60 - 620) x 6% = 356.06
    // Total 6,994.02
    const r = run("AT", "at", { grossMonthly: perMonth(4000), specialPayments: "8000" });
    expect(cents(r.summary.socialContributions)).toBe(10119.2);
    expect(Number(step(r, "at-4").output)).toBe(39194.4);
    expect(Number(step(r, "at-7").output)).toBe(356.06);
    expect(cents(r.summary.incomeTax)).toBe(6994.02);
  });

  it("Austria taxes the 13th and 14th salary far more lightly than ordinary pay", () => {
    const asSpecial = run("AT", "at", { grossMonthly: perMonth(4000), specialPayments: "8000" });
    // The same 8,000 paid as ordinary salary instead
    const asSalary = run("AT", "at", { grossMonthly: perMonth(4000 + 8000 / 12) });
    expect(cents(asSalary.summary.incomeTax)).toBeGreaterThan(cents(asSpecial.summary.incomeTax));
  });

  it("Czechia taxes gross pay: contributions are not deductible", () => {
    const r = run("CZ", "cz", { grossMonthly: monthly(1000000) });
    // The tax base equals gross pay exactly, contributions notwithstanding
    expect(Number(step(r, "cz-3").output)).toBe(1000000);
    expect(Number(step(r, "cz-2").output)).toBeGreaterThan(0);
    // 15% of 1,000,000 = 150,000, less the 30,840 credit
    expect(cents(r.summary.incomeTax)).toBe(119160);
  });

  it("the Czech social security cap bites but health insurance does not", () => {
    const r = run("CZ", "cz", { grossMonthly: monthly(4000000) });
    expect(r.warnings.join(" ")).toContain("cap");
  });
});

describe("Denmark and Norway - two bases at once", () => {
  it("HAND-DERIVED Denmark: DKK 480,000 in an average municipality", () => {
    // AM-bidrag 8% = 38,400, leaving personal income of 441,600
    // Employment allowance 12.75% = 56,304 (under the 63,300 cap)
    // Taxable income 385,296
    // Municipal 25.049% x (385,296 - 54,100) = 82,961.29
    // Bundskat 12.01% x (441,600 - 54,100) = 46,538.75
    // No mellemskat below 641,200. Total 129,500.04
    const r = run("DK", "gennemsnit", { grossMonthly: monthly(480000) });
    expect(cents(r.summary.socialContributions)).toBe(38400);
    expect(Number(step(r, "dk-4").output)).toBe(385296);
    expect(Number(step(r, "dk-5").output)).toBeCloseTo(82961.29, 2);
    expect(Number(step(r, "dk-6").output)).toBe(46538.75);
    expect(cents(r.summary.incomeTax)).toBeCloseTo(129500.04, 2);
  });

  it("the Danish municipality changes the answer by thousands", () => {
    const low = cents(run("DK", "lav", { grossMonthly: monthly(480000) }).summary.incomeTax);
    const high = cents(run("DK", "hoej", { grossMonthly: monthly(480000) }).summary.incomeTax);
    expect(high - low).toBeGreaterThan(15000);
  });

  it("HAND-DERIVED Norway: NOK 720,000", () => {
    // Trygdeavgift 7.6% = 54,720
    // Minstefradrag min(46% x 720,000, 95,700) = 95,700
    // General income 720,000 - 95,700 - 114,540 = 509,760 x 22% = 112,147.20
    // Trinnskatt: 92,200x1.7% = 1,567.40 | 401,700x4% = 16,068.00 => 17,635.40
    // Total 129,782.60
    const r = run("NO", "no", { grossMonthly: monthly(720000) });
    expect(cents(r.summary.socialContributions)).toBe(54720);
    expect(Number(step(r, "no-3").output)).toBe(95700);
    expect(Number(step(r, "no-5").output)).toBe(112147.2);
    expect(Number(step(r, "no-6").output)).toBe(17635.4);
    expect(cents(r.summary.incomeTax)).toBe(129782.6);
  });

  it("Norwegian bracket tax uses gross income, not income after deductions", () => {
    const r = run("NO", "no", { grossMonthly: monthly(720000) });
    // The bracket tax base is the full 720,000, while the 22% base is 509,760
    expect(step(r, "no-1").note).toContain("no deductions at all");
    expect(Number(step(r, "no-4").output)).toBeLessThan(720000);
  });
});

describe("Asia-Pacific", () => {
  it("Japan's employment income deduction stops growing above 8.5 million", () => {
    const below = run("JP", "jp", { grossMonthly: monthly(8000000) });
    const above = run("JP", "jp", { grossMonthly: monthly(12000000) });
    expect(Number(step(below, "jp-3").output)).toBeLessThan(1950000);
    expect(Number(step(above, "jp-3").output)).toBe(1950000);
    expect(above.warnings.join(" ")).toContain("8,500,000");
  });

  it("Japan charges a surtax on the tax and an inhabitant's tax on income", () => {
    const r = run("JP", "jp", { grossMonthly: monthly(6000000) });
    const national = Number(step(r, "jp-5").output);
    // Japan carries no minor units, so every line is floored to whole yen.
    expect(Math.abs(Number(step(r, "jp-6").output) - national * 0.021)).toBeLessThan(1);
    expect(Number(step(r, "jp-7").output)).toBeGreaterThan(0);
  });

  it("China applies a rate with a quick deduction after a flat 60,000 allowance", () => {
    // 300,000 gross - 60,000 = 240,000 taxable, in the 20% row with 16,920
    // 240,000 x 20% - 16,920 = 31,080
    const r = run("CN", "cn", { grossMonthly: monthly(300000) });
    expect(Number(step(r, "cn-3").output)).toBe(240000);
    expect(cents(r.summary.incomeTax)).toBe(31080);
    expect(r.warnings.join(" ")).toContain("social insurance");
  });

  it("Korea's long-term care premium is charged on the health premium, not on salary", () => {
    const r = run("KR", "kr", { grossMonthly: monthly(60000000) });
    const health = Number(step(r, "kr-2").inputs["health insurance"]);
    const ltc = Number(step(r, "kr-2").inputs["long-term care"]);
    // The won carries no minor units, so the premium is floored to whole won.
    expect(Math.abs(ltc - health * 0.1295)).toBeLessThan(1);
  });

  it("Korea adds a local income tax of exactly 10% of the national tax", () => {
    const r = run("KR", "kr", { grossMonthly: monthly(60000000) });
    const national = Number(step(r, "kr-5").output);
    expect(Math.abs(Number(step(r, "kr-6").output) - national * 0.1)).toBeLessThan(1);
  });

  it("New Zealand taxes the first dollar and caps the ACC levy", () => {
    const small = run("NZ", "nz", { grossMonthly: monthly(10000) });
    expect(cents(small.summary.incomeTax)).toBeGreaterThan(0);
    const big = run("NZ", "nz", { grossMonthly: monthly(300000) });
    // 156,641 x 1.75% = 2,741.22
    expect(cents(big.summary.socialContributions)).toBe(2741.22);
  });

  it("the New Zealand earner credit exists only inside a window", () => {
    const inWindow = run("NZ", "nz", { grossMonthly: monthly(50000), ietcEligible: true });
    const above = run("NZ", "nz", { grossMonthly: monthly(80000), ietcEligible: true });
    expect(Number(step(inWindow, "nz-4").output)).toBe(520);
    expect(Number(step(above, "nz-4").output)).toBe(0);
  });
});

describe("Latin America, Africa and Turkiye", () => {
  it("HAND-DERIVED Brazil: R$ 4,000 a month is entirely exempt under the 2026 reform", () => {
    // INSS: 4,000 x 12% - 111.40 = 368.60 a month => 4,423.20
    // IRRF: monthly pay is within the R$ 5,000 exemption, so nil every month
    const r = run("BR", "br", { grossMonthly: perMonth(4000) });
    expect(cents(r.summary.socialContributions)).toBe(4423.2);
    expect(cents(r.summary.incomeTax)).toBe(0);
  });

  it("HAND-DERIVED Brazil: R$ 10,000 a month is above the reform ceiling", () => {
    // INSS capped: 8,475.55 x 14% - 198.49 = 988.09 a month => 11,857.08
    // Base 10,000 - 988.09 = 9,011.91; 27.5% - 908.73 => 1,569.55 a month
    const r = run("BR", "br", { grossMonthly: perMonth(10000) });
    expect(cents(r.summary.socialContributions)).toBe(11857.08);
    expect(cents(r.summary.incomeTax)).toBe(18834.6);
  });

  it("Brazil tests the exemption monthly, so the same annual pay can be taxed differently", () => {
    const even = run("BR", "br", { grossMonthly: perMonth(5000) });
    const lumpy = run("BR", "br", {
      grossMonthly: [...Array(6).fill("10000"), ...Array(6).fill(null)] as FieldValue,
    });
    expect(cents(even.summary.annualGross)).toBe(cents(lumpy.summary.annualGross));
    expect(cents(even.summary.incomeTax)).toBe(0);
    expect(cents(lumpy.summary.incomeTax)).toBeGreaterThan(0);
    expect(lumpy.summary.monthsWorked).toBe(6);
  });

  it("HAND-DERIVED Mexico: MXN 500,000", () => {
    // Row starting at 424,353.98: fixed quota 67,981.92 plus 23.52% of the
    // 75,646.02 excess = 17,791.94 => 85,773.86
    const r = run("MX", "mx", { grossMonthly: monthly(500000) });
    expect(cents(r.summary.incomeTax)).toBeCloseTo(85773.86, 2);
    expect(r.warnings.join(" ")).toContain("subsidio");
  });

  it("HAND-DERIVED South Africa: ZAR 500,000", () => {
    // 245,100x18% = 44,118 | 138,000x26% = 35,880 | 116,900x31% = 36,239
    // => 116,237, less the 17,820 primary rebate => 98,417
    // UIF: 177.12 a month capped => 2,125.44
    const r = run("ZA", "za", { grossMonthly: monthly(500000) });
    expect(Number(step(r, "za-4").output)).toBe(116237);
    expect(cents(r.summary.incomeTax)).toBe(98417);
    expect(cents(r.summary.socialContributions)).toBe(2125.44);
  });

  it("the South African rebate makes the threshold exactly 99,000", () => {
    // 18% of 99,000 is 17,820, which is the primary rebate to the rand
    const at = run("ZA", "za", { grossMonthly: monthly(99000) });
    expect(cents(at.summary.incomeTax)).toBe(0);
    const just = run("ZA", "za", { grossMonthly: monthly(100000) });
    expect(cents(just.summary.incomeTax)).toBeGreaterThan(0);
  });

  it("HAND-DERIVED Turkiye: TRY 1,200,000", () => {
    // SGK 15% of 100,000 a month = 180,000; base 1,020,000
    //   190,000x15% = 28,500 | 210,000x20% = 42,000 | 620,000x27% = 167,400
    //   => 237,900
    // Minimum wage exemption: base 28,075.50 x 12 = 336,906
    //   190,000x15% = 28,500 | 146,906x20% = 29,381.20 => 57,881.20
    // Payable 180,018.80
    const r = run("TR", "tr", { grossMonthly: perMonth(100000) });
    expect(cents(r.summary.socialContributions)).toBe(180000);
    expect(Number(step(r, "tr-4").output)).toBe(237900);
    expect(Number(step(r, "tr-5").output)).toBeCloseTo(57881.2, 2);
    expect(cents(r.summary.incomeTax)).toBeCloseTo(180018.8, 2);
  });

  it("Saudi Arabia has no income tax, and GOSI depends on nationality", () => {
    const expat = run("SA", "sa", { grossMonthly: perMonth(30000), nationality: "expatriate" });
    expect(cents(expat.summary.incomeTax)).toBe(0);
    expect(cents(expat.summary.socialContributions)).toBe(0);
    expect(cents(expat.summary.takeHome)).toBe(360000);

    // A Saudi national on the same pay: 9.75% of 30,000 a month
    const saudi = run("SA", "sa", { grossMonthly: perMonth(30000), nationality: "saudi" });
    expect(cents(saudi.summary.socialContributions)).toBe(35100);
    expect(cents(saudi.summary.incomeTax)).toBe(0);
  });

  it("GOSI stops at the SAR 45,000 monthly ceiling", () => {
    const at = run("SA", "sa", { grossMonthly: perMonth(45000), nationality: "saudi" });
    const above = run("SA", "sa", { grossMonthly: perMonth(90000), nationality: "saudi" });
    expect(cents(above.summary.socialContributions)).toBe(cents(at.summary.socialContributions));
  });
});
