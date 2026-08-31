"use client";

import { useState } from "react";
import type { FieldSpec, FieldValue, MonthlyValue } from "../engine/types";
import { MONTHS } from "../engine/inputs";

const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

function Help({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[10px] font-semibold text-slate-500 hover:border-slate-500 hover:text-slate-700"
      >
        ?
      </button>
      {open && (
        <p className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
          {text}
        </p>
      )}
    </>
  );
}

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm tabular text-right shadow-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

/** Twelve slots. A blank month is a month with no income, never an average. */
export function MonthlyGrid({
  field,
  value,
  onChange,
  symbol,
}: {
  field: FieldSpec;
  value: MonthlyValue;
  onChange: (v: MonthlyValue) => void;
  symbol: string;
}) {
  const filled = value.filter((v) => v !== null && v !== "").length;

  function setMonth(i: number, raw: string) {
    const next = [...value];
    next[i] = raw === "" ? null : raw;
    onChange(next);
  }

  function fillDown() {
    const first = value.find((v) => v !== null && v !== "");
    if (first === undefined) return;
    onChange(Array.from({ length: 12 }, () => first));
  }

  return (
    <fieldset className="rounded-lg border border-slate-200 bg-white p-4">
      <legend className="px-1 text-sm font-medium text-slate-800">
        {field.label}
        <Help text={field.help} />
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {SHORT_MONTHS.map((m, i) => (
          <label key={m} className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-xs font-medium text-slate-500">{m}</span>
            <span className="relative flex-1">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                {symbol}
              </span>
              <input
                type="text"
                inputMode="decimal"
                className={inputClass}
                value={value[i] ?? ""}
                placeholder="—"
                onChange={(e) => setMonth(i, e.target.value)}
                aria-label={`${field.label} - ${MONTHS[i]}`}
              />
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <button
          type="button"
          onClick={fillDown}
          className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-600 hover:border-slate-500 hover:text-slate-800"
        >
          Copy first value to all 12
        </button>
        <button
          type="button"
          onClick={() => onChange(Array.from({ length: 12 }, () => null))}
          className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-600 hover:border-slate-500 hover:text-slate-800"
        >
          Clear
        </button>
        <span>
          {filled} of 12 months entered. Blank months are treated as months with no income — the
          year is never annualised.
        </span>
      </div>
    </fieldset>
  );
}

export function Field({
  field,
  value,
  onChange,
  symbol,
}: {
  field: FieldSpec;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  symbol: string;
}) {
  if (field.kind === "monthly-money") {
    return (
      <MonthlyGrid
        field={field}
        value={(Array.isArray(value) ? value : Array.from({ length: 12 }, () => null)) as MonthlyValue}
        onChange={onChange}
        symbol={symbol}
      />
    );
  }

  const label = (
    <span className="text-sm font-medium text-slate-800">
      {field.label}
      {field.optional ? <span className="ml-1 text-xs text-slate-400">optional</span> : null}
    </span>
  );

  if (field.kind === "bool") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
        <Help text={field.help} />
      </div>
    );
  }

  if (field.kind === "enum") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <label className="block">
          {label}
          <select
            className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            value={typeof value === "string" ? value : String(field.default ?? "")}
            onChange={(e) => onChange(e.target.value)}
          >
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Help text={field.help} />
      </div>
    );
  }

  const isMoney = field.kind === "annual-money";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <label className="block">
        {label}
        <span className="relative mt-1.5 block">
          {isMoney && (
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">
              {symbol}
            </span>
          )}
          <input
            type="text"
            inputMode={isMoney ? "decimal" : "numeric"}
            className={inputClass}
            value={value === null || value === undefined || typeof value === "boolean" || Array.isArray(value) ? "" : String(value)}
            placeholder={isMoney ? (symbol === "€" ? "0,00" : "0.00") : String(field.default ?? "0")}
            onChange={(e) => onChange(e.target.value)}
          />
        </span>
      </label>
      <Help text={field.help} />
    </div>
  );
}
