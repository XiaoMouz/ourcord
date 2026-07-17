import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type PromptField = { name: string; label: string; placeholder?: string; initial?: string; required?: boolean; maxLength?: number };
export type ConfirmOpts = { title: string; message?: string; confirmLabel?: string; danger?: boolean };
export type PromptOpts = { title: string; fields: PromptField[]; confirmLabel?: string };

type Pending =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (ok: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (values: Record<string, string> | null) => void };

type DialogAPI = {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<Record<string, string> | null>;
  // promptText is the common single-field case, returning the trimmed value.
  promptText: (title: string, field: Omit<PromptField, "name">) => Promise<string | null>;
};

const DialogContext = createContext<DialogAPI | null>(null);

export function useDialog(): DialogAPI {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialog must be used within a DialogProvider");
  return api;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => setPending({ kind: "confirm", opts, resolve })), []);
  const prompt = useCallback((opts: PromptOpts) =>
    new Promise<Record<string, string> | null>((resolve) => setPending({ kind: "prompt", opts, resolve })), []);
  const promptText = useCallback(async (title: string, field: Omit<PromptField, "name">) => {
    const values = await prompt({ title, fields: [{ name: "value", ...field }] });
    return values ? values.value : null;
  }, [prompt]);

  const settle = useCallback((result: boolean | Record<string, string> | null) => {
    setPending((current) => {
      if (!current) return null;
      if (current.kind === "confirm") current.resolve(result === true);
      else current.resolve(result === null || result === false ? null : (result as Record<string, string>));
      return null;
    });
  }, []);

  return <DialogContext.Provider value={{ confirm, prompt, promptText }}>
    {children}
    {pending && <DialogHost pending={pending} settle={settle} />}
  </DialogContext.Provider>;
}

function DialogHost({ pending, settle }: { pending: Pending; settle: (result: boolean | Record<string, string> | null) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    pending.kind === "prompt" ? Object.fromEntries(pending.opts.fields.map((f) => [f.name, f.initial ?? ""])) : {});
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => { firstInput.current?.focus(); firstInput.current?.select(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") settle(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settle]);

  const missingRequired = pending.kind === "prompt" &&
    pending.opts.fields.some((f) => f.required && !values[f.name]?.trim());

  function submit() {
    if (pending.kind === "confirm") { settle(true); return; }
    if (missingRequired) return;
    settle(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  }

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && settle(null)}>
    <section className="dialog" role="dialog" aria-modal="true">
      <h2>{pending.opts.title}</h2>
      {pending.kind === "confirm" && pending.opts.message && <p className="dialog-message">{pending.opts.message}</p>}
      {pending.kind === "prompt" && <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {pending.opts.fields.map((field, index) => <label key={field.name}>{field.label}
          <input ref={index === 0 ? firstInput : undefined} value={values[field.name] ?? ""}
            placeholder={field.placeholder} maxLength={field.maxLength}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))} />
        </label>)}
        <button type="submit" hidden />
      </form>}
      <div className="dialog-actions">
        <button className="dialog-cancel" onClick={() => settle(null)}>取消</button>
        <button className={pending.kind === "confirm" && pending.opts.danger ? "dialog-confirm danger" : "dialog-confirm"}
          disabled={missingRequired} onClick={submit}>
          {pending.kind === "confirm" ? (pending.opts.confirmLabel ?? "确定") : (pending.opts.confirmLabel ?? "确定")}
        </button>
      </div>
    </section>
  </div>;
}
