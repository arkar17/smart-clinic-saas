import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import type { DaySchedule } from '@sc/contracts';
import { ApiError, get } from './api';

/** Reusable components (SC1-FE-02). */
export function Field({ label, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string[] }) {
  const id = props.id ?? props.name ?? label;
  return (
    <label htmlFor={id} className="block text-sm">
      <span className="font-medium">{label}</span>
      {props.type === 'checkbox' ? (
        <input id={id} {...props} className="ml-2 align-middle" />
      ) : (
        <input id={id} {...props} aria-invalid={!!error} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 focus:outline-2 focus:outline-brand aria-[invalid=true]:border-red-500" />
      )}
      {error?.map((e) => <span key={e} role="alert" className="block text-xs text-red-600">{e}</span>)}
    </label>
  );
}

export function Select({ label, options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: { value: string; label: string }[] }) {
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <select {...props} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = { primary: 'bg-brand text-white hover:bg-brand-dark', secondary: 'border border-slate-300 bg-white hover:bg-slate-100', danger: 'bg-red-600 text-white hover:bg-red-700' };
  return <button type="button" {...props} className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${styles[variant]} ${props.className ?? ''}`} />;
}

export function DataTable<T>({ rows, columns, empty = 'Nothing here yet.' }: { rows: T[]; columns: { header: string; cell: (row: T) => ReactNode }[]; empty?: string }) {
  if (!rows.length) return <EmptyState text={empty} />;
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-left">
          <tr>{columns.map((c) => <th key={c.header} scope="col" className="px-3 py-2 font-semibold">{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{columns.map((c) => <td key={c.header} className="px-3 py-2 align-top">{c.cell(r)}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="w-full max-w-lg rounded-lg p-0 backdrop:bg-black/40" aria-labelledby="dialog-title">
      <div className="p-4">
        <h2 id="dialog-title" className="mb-3 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const show = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4">
        {toast && <div className={`rounded px-4 py-2 text-sm text-white shadow ${toast.kind === 'ok' ? 'bg-slate-800' : 'bg-red-600'}`}>{toast.msg}</div>}
      </div>
    </ToastCtx.Provider>
  );
}

export const EmptyState = ({ text }: { text: string }) => <p className="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">{text}</p>;
export const Loading = () => <p className="text-sm text-slate-500" role="status">Loading…</p>;
export const ErrorState = ({ error }: { error: unknown }) => <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error instanceof Error ? error.message : 'Something went wrong.'}</p>;

/** Loads a GET resource; `reload` re-fetches after a mutation. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    if (!path) return;
    get<T>(path).then(setData, setError);
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

/** Field-error helper for ApiError VALIDATION_ERROR responses. */
export const fieldsOf = (e: unknown) => (e instanceof ApiError ? e.body.fields ?? {} : {});
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** Time-interval editor: per weekday CLOSED or open/close with 0–3 breaks (BR-040/041, BR-045). */
export function WeekEditor({ value, onChange, errors = {} }: { value: DaySchedule[]; onChange: (v: DaySchedule[]) => void; errors?: Record<string, string[]> }) {
  const update = (i: number, patch: Partial<DaySchedule>) => onChange(value.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-2">
      {value.map((d, i) => (
        <fieldset key={d.weekday} className="rounded border border-slate-200 bg-white p-2">
          <legend className="px-1 text-sm font-semibold">{WEEKDAYS[d.weekday - 1]}</legend>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Closed" type="checkbox" checked={d.closed} onChange={(e) => update(i, e.target.checked ? { closed: true, open: undefined, close: undefined, breaks: [] } : { closed: false, open: '09:00', close: '17:00' })} />
            {!d.closed && (
              <>
                <Field label="Open" type="time" value={d.open ?? ''} onChange={(e) => update(i, { open: e.target.value })} error={errors[`days.${i}.open`]} />
                <Field label="Close" type="time" value={d.close ?? ''} onChange={(e) => update(i, { close: e.target.value })} error={errors[`days.${i}.close`]} />
                {d.breaks.map((b, j) => (
                  <span key={j} className="flex items-end gap-1">
                    <Field label={`Break ${j + 1} from`} type="time" value={b.start} onChange={(e) => update(i, { breaks: d.breaks.map((x, k) => (k === j ? { ...x, start: e.target.value } : x)) })} error={errors[`days.${i}.breaks.${j}`]} />
                    <Field label="to" type="time" value={b.end} onChange={(e) => update(i, { breaks: d.breaks.map((x, k) => (k === j ? { ...x, end: e.target.value } : x)) })} error={errors[`days.${i}.breaks.${j}.end`]} />
                    <Button variant="secondary" aria-label="Remove break" onClick={() => update(i, { breaks: d.breaks.filter((_, k) => k !== j) })}>×</Button>
                  </span>
                ))}
                {d.breaks.length < 3 && <Button variant="secondary" onClick={() => update(i, { breaks: [...d.breaks, { start: '12:00', end: '13:00' }] })}>Add break</Button>}
              </>
            )}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
