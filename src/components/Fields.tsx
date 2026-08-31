"use client";

import { useState } from "react";
import type { FieldSpec, FieldValue, MonthlyValue } from "../engine/types";
import { MONTHS } from "../engine/inputs";

const SHORT = MONTHS.map((m) => m.slice(0, 3));
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

/**
 * Help is set as a footnote: a dagger against the label itself, and the note in
 * the statute voice underneath. Most people never open one; nobody has to
 * scroll past fifteen of them.
 */
function useNote(text?: string) {
  const [open, setOpen] = useState(false);
  const mark = text ? (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-label={open ? "Hide the note" : "Show the note"}
      className={`f-figure ml-1 align-super text-[0.6875rem] leading-none ${
        open ? "text-[var(--color-flag)]" : "text-[var(--color-ink-faint)]"
      } hover:text-[var(--color-flag)]`}
    >
      †
    </button>
  ) : null;
  const note = open && text ? <p className="margin-note mt-2">{text}</p> : null;
  return { mark, note };
}

function Label({ field, mark }: { field: FieldSpec; mark?: React.ReactNode }) {
  return (
    <span className="text-[0.8125rem] leading-snug font-medium">
      {field.label}
      {field.optional && (
        <span className="citation ml-1.5" style={{ fontSize: "0.625rem" }}>
          optional
        </span>
      )}
      {mark}
    </span>
  );
}

/** Twelve ruled blanks, grouped into the quarters they actually fall in. */
function MonthlyGrid({
  field,
  value,
  onChange,
  symbol,
  mark,
  note,
}: {
  field: FieldSpec;
  value: MonthlyValue;
  onChange: (v: MonthlyValue) => void;
  symbol: string;
  mark: React.ReactNode;
  note: React.ReactNode;
}) {
  const filled = value.filter((v) => v !== null && v !== "").length;

  function setMonth(i: number, raw: string) {
    const next = [...value];
    next[i] = raw === "" ? null : raw;
    onChange(next);
  }

  return (
    <fieldset className="mb-6">
      <legend className="mb-1 block">
        <Label field={field} mark={mark} />
      </legend>
      {note && <div className="mb-3">{note}</div>}

      <div className="space-y-1.5">
        {QUARTERS.map((q, qi) => (
          <div key={q} className="flex items-end gap-2">
            <span className="citation w-5 shrink-0 pb-1" style={{ fontSize: "0.625rem" }}>
              {q}
            </span>
            <div className="grid flex-1 grid-cols-3 gap-2">
              {[0, 1, 2].map((mi) => {
                const i = qi * 3 + mi;
                return (
                  <label key={i} className="block">
                    <span className="citation block pb-0.5" style={{ fontSize: "0.5625rem" }}>
                      {SHORT[i].toUpperCase()}
                    </span>
                    <span className="flex items-baseline gap-1">
                      <span className="citation shrink-0" style={{ fontSize: "0.625rem" }}>
                        {symbol}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="blank marked"
                        value={value[i] ?? ""}
                        placeholder="—"
                        onChange={(e) => setMonth(i, e.target.value)}
                        aria-label={`${field.label} - ${MONTHS[i]}`}
                      />
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={() => {
            const first = value.find((v) => v !== null && v !== "");
            if (first !== undefined) onChange(Array.from({ length: 12 }, () => first));
          }}
          className="eyebrow underline decoration-dotted underline-offset-4 hover:text-[var(--color-ink)]"
        >
          Repeat first
        </button>
        <button
          type="button"
          onClick={() => onChange(Array.from({ length: 12 }, () => null))}
          className="eyebrow underline decoration-dotted underline-offset-4 hover:text-[var(--color-ink)]"
        >
          Clear
        </button>
        <span className="citation">
          {filled} of 12 entered · a blank month is a month with no income
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
  // The hook runs before any branch, so every field kind takes the same path.
  const { mark, note } = useNote(field.help);

  if (field.kind === "monthly-money") {
    return (
      <MonthlyGrid
        field={field}
        value={
          (Array.isArray(value) ? value : Array.from({ length: 12 }, () => null)) as MonthlyValue
        }
        onChange={onChange}
        symbol={symbol}
        mark={mark}
        note={note}
      />
    );
  }

  if (field.kind === "bool") {
    const checked = value === true;
    return (
      <div className="mb-4">
        <label className="flex cursor-pointer items-start gap-2.5">
          <span
            aria-hidden
            className={`f-figure mt-0.5 grid h-4 w-4 flex-none place-items-center border text-[0.625rem] leading-none ${
              checked
                ? "border-[var(--color-ink)] bg-[var(--color-mark)]"
                : "border-[var(--color-rule)] bg-transparent"
            }`}
          >
            {checked ? "×" : ""}
          </span>
          <input
            type="checkbox"
            className="sr-only"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <Label field={field} mark={mark} />
        </label>
        {note && <div className="pl-6">{note}</div>}
      </div>
    );
  }

  if (field.kind === "enum") {
    return (
      <div className="mb-4">
        <label className="block">
          <Label field={field} mark={mark} />
          <select
            className="picker mt-1"
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
        {note}
      </div>
    );
  }

  const isMoney = field.kind === "annual-money";
  return (
    <div className="mb-4">
      <label className="flex items-baseline gap-3">
        <span className="flex-1">
          <Label field={field} mark={mark} />
        </span>
        <span className="flex w-32 shrink-0 items-baseline gap-1">
          {isMoney && (
            <span className="citation shrink-0" style={{ fontSize: "0.625rem" }}>
              {symbol}
            </span>
          )}
          <input
            type="text"
            inputMode={isMoney ? "decimal" : "numeric"}
            className="blank marked"
            value={
              value === null || value === undefined || typeof value === "boolean" ||
              Array.isArray(value)
                ? ""
                : String(value)
            }
            placeholder={isMoney ? (symbol === "€" ? "0,00" : "0.00") : String(field.default ?? "0")}
            onChange={(e) => onChange(e.target.value)}
          />
        </span>
      </label>
      {note}
    </div>
  );
}
