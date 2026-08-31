import { Decimal, d, ZERO, sum, min, type Rounding, round } from "./money";

export interface BandSpec {
  /** Upper edge of the band, or null for the open top band. */
  upTo: string | null;
  rate: string;
}

export interface ScaleSpec {
  bands: BandSpec[];
  legalRef?: string;
  note?: string;
}

export interface BandRow {
  from: Decimal;
  to: Decimal | null;
  rate: Decimal;
  taxableInBand: Decimal;
  tax: Decimal;
}

export interface BracketResult {
  total: Decimal;
  rows: BandRow[];
  /** Rate of the band the last euro/dollar of the base falls into. */
  marginalRate: Decimal;
}

/**
 * Evaluate a progressive scale over a base.
 *
 * This is deliberately dumb: it applies bands to whatever base it is handed and
 * knows nothing about allowances, minimums or credits. Each country adapter
 * decides what base to feed it and what to do with the answer - that is the
 * whole point, because Spain subtracts a second bracket evaluation while Canada
 * subtracts credits valued at a fixed rate.
 */
export function evaluateScale(base: Decimal, scale: ScaleSpec, rounding: Rounding): BracketResult {
  const rows: BandRow[] = [];
  let lower = ZERO;
  let marginalRate = ZERO;

  for (const band of scale.bands) {
    const upper = band.upTo === null ? null : d(band.upTo);
    const rate = d(band.rate);

    const cappedBase = upper === null ? base : min(base, upper);
    const taxableInBand = cappedBase.minus(lower);

    if (taxableInBand.gt(0)) {
      rows.push({
        from: lower,
        to: upper,
        rate,
        taxableInBand,
        tax: round(taxableInBand.times(rate), rounding),
      });
      marginalRate = rate;
    }

    if (upper === null || base.lte(upper)) break;
    lower = upper;
  }

  // A base of exactly zero still reports the first band's rate as marginal:
  // the next unit of income would be taxed there.
  if (rows.length === 0 && scale.bands.length > 0) {
    marginalRate = d(scale.bands[0].rate);
  }

  return {
    total: round(sum(rows.map((r) => r.tax)), rounding),
    rows,
    marginalRate,
  };
}

/** The rate that would apply to one more unit of base. Used for the marginal rate display. */
export function marginalRateAt(base: Decimal, scale: ScaleSpec): Decimal {
  let lower = ZERO;
  for (const band of scale.bands) {
    if (band.upTo === null) return d(band.rate);
    const upper = d(band.upTo);
    if (base.lt(upper)) return d(band.rate);
    lower = upper;
  }
  return d(scale.bands[scale.bands.length - 1]?.rate ?? 0);
}

export function topRate(scale: ScaleSpec): Decimal {
  return d(scale.bands[scale.bands.length - 1]?.rate ?? 0);
}
