# Golden test coverage — what is and is not proven

## What the current suite proves

268 tests pass across six files and twelve countries. They prove that:

- each pipeline runs in the order its jurisdiction actually requires;
- the arithmetic matches values derived **longhand from the ruleset figures**, written out in the comment above each assertion;
- the structural traps are handled — Spain's rate-scale subtraction, Canada's credits at the lowest rate and Ontario's surtax on tax, Hong Kong's lower-of-two computations, Germany's polynomial zones joining continuously, the UK's 60% band and per-period NI, the Dutch double taper, Poland's non-deductible health charge, Singapore's single relief cap, India's two marginal reliefs and cess, Australia's shade-in and non-refundable offset, Kuwait's absence of an income tax;
- monthly ceilings are applied monthly, annual ceilings annually, and a partial year is never annualised;
- the invariants hold across 29 income points in 18 jurisdiction configurations.

## What the current suite does NOT prove

**No value here comes from a tax authority's own worked example.** Every "golden" number is derived from the ruleset JSON. If a rate in a ruleset is wrong, the test agrees with the wrong rate. The tests verify the *pipeline*; they do not verify the *inputs to the pipeline*.

## Source quality, by country

Read on 31 August 2026. Ranked by how much weight the figures can bear.

| Confidence | Country | Source actually used |
| --- | --- | --- |
| **Statute text fetched directly** | Germany | §32a EStG at gesetze-im-internet.de, which states the version applies from assessment year 2026. The five zones join continuously under test, which independently corroborates the coefficients. |
| **Tax authority table fetched directly** | Netherlands | The Belastingdienst's own 2026 arbeidskorting table. |
| **Reputable secondary, fetched** | Hong Kong, UK, Poland, Singapore, India, Australia, Bulgaria, Kuwait | PwC Worldwide Tax Summaries, plus a government press release for Hong Kong's 2026/27 allowances. |
| **Transcribed from the build brief** | Spain (state scale), Canada (federal) | Supplied in the original specification, not independently fetched. |
| **Derived by indexation** | Spain (all four regional scales), Canada (Ontario, BC, Alberta) | Previous-year figures multiplied by each jurisdiction's published indexation factor. The weakest figures in the project. |

## To close the gap before shipping

For each country, take the tax authority's own worked examples and add them as tests with the published result as the expected value:

- **Spain** — AEAT *Manual Práctico Renta*, chapters on rendimientos del trabajo, mínimo personal y familiar and cálculo del impuesto. Cross-check one full return per region against Renta WEB.
- **Canada** — CRA **T4127**, Chapter 8 (annual formula) for Ontario, BC and Alberta.
- **Hong Kong** — the IRD's own tax computation examples and its online calculator.
- **Germany** — the BMF *Lohn- und Einkommensteuerrechner*, which implements §32a directly.
- **UK** — HMRC's PAYE and Scottish rate examples; confirm the 2026/27 NI thresholds.
- **Netherlands** — the Belastingdienst *loonbelastingtabellen*.
- **Poland** — Ministry of Finance PIT examples; confirm the deductible-cost amounts.
- **Singapore** — IRAS worked examples and the CPF contribution calculator.
- **India** — the Income Tax Department's e-filing tax calculator, especially at the ₹12,00,000 rebate boundary and each surcharge threshold.
- **Australia** — the ATO *Simple tax calculator*, and its Medicare levy and LITO worked examples.
- **Bulgaria / Kuwait** — NRA and PIFSS published schedules.

Then set `provenance.verifiedOn` and change `confidence` to `"verified"` — one file at a time, only once its figures have actually been checked — and work through each ruleset's `verificationTodo` array.

## Highest-risk figures

Each is the single line to correct in the named file.

| Figure | File | Risk if wrong |
| --- | --- | --- |
| All four regional scales | `rules/es/2026/*.json` | Shifts every Spanish result in that region |
| Monthly maximum contribution base | `rules/es/2026/_national.json` | 2025 value carried forward; understates contributions for high earners |
| Work-income reduction amounts | `rules/es/2026/_national.json` | Materially affects everyone under about €23,300 |
| Provincial brackets and BPAs | `rules/ca/2026/{on,bc,ab}.json` | Derived by indexation, not published figures |
| Alberta indexation | `rules/ca/2026/ab.json` | Alberta has suspended indexation in past years |
| Class 1 NI thresholds | `rules/gb/2026/national.json` | Source stated them as "2025/26 onwards", not as 2026/27 figures |
| Scottish band boundaries | `rules/gb/2026/national.json` | Expressed as taxable income after the allowance; the published figures are total income |
| Contribution ceilings | `rules/de/2026/national.json` | From secondary sources, not the Rechengrößenverordnung |
| Algemene heffingskorting | `rules/nl/2026/national.json` | From a search summary, unlike the arbeidskorting table |
| Deductible costs | `rules/pl/2026/national.json` | PLN 250/month was not re-checked in this pass |
| CPF ceiling and relief cap | `rules/sg/2026/national.json` | Ceiling rose in 2026; confirm the year applied |
| Slabs for FY 2026-27 | `rules/in/2026/national.json` | Source stated "FY 2025/26 onwards"; a Finance Act 2026 change would supersede |
| Medicare threshold and LITO | `rules/au/2026/national.json` | Secondary sources only |
| PIFSS ceilings | `rules/kw/2026/national.json` | Two separate ceilings on two rates; both need confirming |
| Maximum insurance base | `rules/bg/2026/national.json` | Changes mid-year; confirm both halves |
