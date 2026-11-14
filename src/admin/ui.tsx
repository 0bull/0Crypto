import { cloneElement, isValidElement, type Child } from "hono/jsx";
import { NEEDS_JS } from "./confirm";

/*
 * The admin's building blocks (Plan 8). Server-rendered only, styled by public/admin.css: the CSP forbids inline
 * styles, so no component takes a `style` prop and every visual choice is a class. Charts are SVG with presentation
 * attributes (x, height, viewBox, fill="url(#…)"), which the CSP allows.
 */

/** A rounded card. With a title it has an <h2> (and `aside` on its right); without one, `label` names it. */
export function Panel(props: { title?: string; aside?: Child; tone?: "warn"; label?: string; id?: string; children?: Child }) {
  const cls = props.tone === "warn" ? "panel panel-warn" : "panel";
  return (
    <section class={cls} id={props.id} aria-label={props.title === undefined ? props.label : undefined}>
      {props.title !== undefined ? (
        <div class="panel-head">
          <h2>{props.title}</h2>
          {props.aside ?? null}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

/** One figure: a small muted label, the number in Archivo, an optional hint (coloured by `trend`). */
export function Stat(props: { label: string; value: string; hint?: Child; trend?: "up" | "down" }) {
  return (
    <div class="stat">
      <p class="stat-label">{props.label}</p>
      <p class="num">{props.value}</p>
      {props.hint !== undefined ? <p class={props.trend ? `stat-hint trend-${props.trend}` : "stat-hint"}>{props.hint}</p> : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { open: "Waiting", partially_paid: "Partially paid", partial: "Partial" };
/** The words a status pill shows: "open" reads as "Waiting", the rest capitalised. */
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const HOLLOW = new Set(["open", "expired", "awaiting"]);

/** A status pill (theme.css colours): a filled dot, or a hollow one while waiting or expired. `label` overrides the words. */
export function StatusPill(props: { status: string; label?: string }) {
  return (
    <span class={`pill pill-${props.status}`}>
      <span aria-hidden="true">{HOLLOW.has(props.status) ? "○" : "●"}</span>
      {props.label ?? statusLabel(props.status)}
    </span>
  );
}

/** A DataTable column: `mono` for ids, addresses and amounts; `nowrap` keeps a short value (an amount, a coin, a status) on one line. */
export type Column<T> = { head: string; cell: (r: T) => Child; mono?: boolean; nowrap?: boolean };

/**
 * A real table with an accessible name. Every cell carries its column head in `data-label`, which the phone layout
 * shows before the value (the rows stack into labelled blocks there; `nowrap` cells may wrap there). With no rows it
 * renders `empty` instead.
 */
export function DataTable<T>(props: { label: string; columns: Column<T>[]; rows: T[]; empty: Child }) {
  if (props.rows.length === 0) return <>{props.empty}</>;
  return (
    <div class="table-wrap">
      <table class="table" aria-label={props.label}>
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th scope="col">{col.head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr>
              {props.columns.map((col) => (
                <td data-label={col.head} class={[col.mono ? "mono" : "", col.nowrap ? "nowrap" : ""].filter(Boolean).join(" ") || undefined}>
                  {col.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What a list shows before it has anything: a title, a line of help, and the action that fills it. */
export function EmptyState(props: { title: string; children?: Child; action?: Child }) {
  return (
    <div class="empty">
      <p class="empty-title">{props.title}</p>
      {props.children !== undefined ? <p class="muted small">{props.children}</p> : null}
      {props.action !== undefined ? <div class="empty-action">{props.action}</div> : null}
    </div>
  );
}

/** A one-line outcome: `ok` is announced politely (status), `error` at once (alert). */
export function Flash(props: { kind: "ok" | "error"; children?: Child }) {
  return props.kind === "ok" ? (
    <p class="flash flash-ok" role="status">
      {props.children}
    </p>
  ) : (
    <p class="flash flash-error" role="alert">
      {props.children}
    </p>
  );
}

/**
 * The outcome of a webhook test event (Developers and the wizard's done step): the ok look only for a 2xx answer;
 * any other answer, or none, is an error that says what to check.
 */
export function WebhookTestResult(props: { status: number; error: string | null }) {
  const { status, error } = props;
  if (status >= 200 && status < 300) return <Flash kind="ok">{`Test event: HTTP ${status}. Your endpoint accepted it.`}</Flash>;
  return (
    <Flash kind="error">
      {status > 0
        ? `Test event: HTTP ${status}. Your endpoint did not accept it: check its logs and the URL, then send another.`
        : `Test event: no response${error ? ` (${error})` : ""}. Check the URL and that your server is reachable, then send another.`}
    </Flash>
  );
}

/** The ids a Field gives its control, hint and error (for a hand-written control that wants the same wiring). */
export const fieldIds = (name: string, id?: string) => {
  const base = id ?? `f-${name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return { control: base, hint: `${base}-hint`, error: `${base}-error` };
};

/**
 * A labelled form control. Without children it is an <input>; with children (a <select>) it renders them, adding the
 * same id and ARIA wiring when the child is a single element. The hint and error are linked by aria-describedby, and
 * an error marks the control aria-invalid. The field name is never changed (passkey-confirm forms bind by name).
 */
export function Field(props: {
  label: string;
  name: string;
  hint?: string;
  error?: string;
  value?: string;
  type?: string;
  required?: boolean;
  readonly?: boolean;
  mono?: boolean;
  inputmode?: "decimal" | "email" | "none" | "numeric" | "search" | "tel" | "text" | "url";
  autocomplete?: string;
  maxlength?: number;
  placeholder?: string;
  pattern?: string;
  id?: string;
  children?: Child;
}) {
  const ids = fieldIds(props.name, props.id);
  const describedBy = [props.hint ? ids.hint : null, props.error ? ids.error : null].filter((x) => x !== null).join(" ") || undefined;
  const aria = { id: ids.control, "aria-describedby": describedBy, "aria-invalid": props.error ? "true" : undefined };
  const cls = props.mono ? "input mono" : "input";
  let control: Child;
  if (props.children === undefined || props.children === null) {
    control = (
      <input
        class={cls}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        required={props.required}
        readonly={props.readonly}
        inputmode={props.inputmode}
        autocomplete={props.autocomplete}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
        pattern={props.pattern}
        {...aria}
      />
    );
  } else {
    const only = Array.isArray(props.children) && props.children.length === 1 ? props.children[0] : props.children;
    control = isValidElement(only) ? cloneElement(only, aria) : props.children;
  }
  return (
    <div class={props.error ? "field has-error" : "field"}>
      <label for={ids.control}>{props.label}</label>
      {control}
      {props.hint ? (
        <p class="hint" id={ids.hint}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p class="field-error" id={ids.error}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** Label/value pairs as a description list. */
export function KeyValue(props: { rows: [string, Child][] }) {
  return (
    <dl class="kv">
      {props.rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

/** A segmented switch made of plain links (works without JavaScript); the active one has aria-current="true". */
export function SegLinks(props: { label: string; items: { href: string; label: string; on: boolean }[] }) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      {props.items.map((it) => (
        <a href={it.href} class={it.on ? "is-on" : undefined} aria-current={it.on ? "true" : undefined}>
          {it.label}
        </a>
      ))}
    </div>
  );
}

export type IconName = "home" | "invoice" | "link" | "pos" | "repeat" | "wallet" | "shield" | "code" | "key" | "gear" | "more" | "out";
const ICONS: Record<IconName, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5.5 9v11.5h13V9"],
  invoice: ["M6 3h8.5L19 7.5V21H6z", "M9.5 12h6M9.5 16h4"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  pos: ["M4 4.5h16v11H4z", "M8.5 20h7M12 15.5V20"],
  repeat: ["M17 3l3.5 3.5L17 10M3.5 12V9.5a3 3 0 0 1 3-3h14", "M7 21l-3.5-3.5L7 14M20.5 12v2.5a3 3 0 0 1-3 3h-14"],
  wallet: ["M3.5 7.5h15a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-13a2 2 0 0 1-2-2z", "M3.5 7.5 15 3.5v4M16 14.5h1.5"],
  shield: ["M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z", "M9 12l2 2 4-4"],
  code: ["M8 7.5 3.5 12 8 16.5M16 7.5l4.5 4.5-4.5 4.5", "M13.5 5l-3 14"],
  key: ["M9.5 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z", "M13 13l7.5 7.5M17.5 17.5l2-2"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"],
  more: ["M4 6.5h16M4 12h16M4 17.5h16"],
  out: ["M14.5 4H19v16h-4.5", "M10 8l-4 4 4 4M6 12h10"],
};

/** A 24×24 stroke icon in the text colour; decorative (aria-hidden), the link text names the item. */
export function Icon(props: { name: IconName }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {ICONS[props.name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

/**
 * A server-drawn bar chart: one bar per entry, 10 units apart, scaled to the largest value with bigint math (no
 * floating point, no NaN). Every bar is at least 2 high, so an all-zero period still draws a baseline. The SVG
 * stretches to its container (preserveAspectRatio="none"); the last bar (the period still running) is `bar-now`.
 */
export function BarChart(props: { label: string; bars: { key: string; value: bigint; title: string }[]; height?: number }) {
  const height = props.height ?? 120;
  const n = props.bars.length;
  const max = props.bars.reduce((m, b) => (b.value > m ? b.value : m), 0n);
  const room = BigInt(height - 4);
  const barHeight = (v: bigint): number => {
    if (max <= 0n || v <= 0n) return 2;
    const h = (v * room) / max;
    return h < 2n ? 2 : Number(h);
  };
  return (
    <svg class="chart" viewBox={`0 0 ${n * 10} ${height}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <defs>
        <linearGradient id="bar-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="bar-stop-top" />
          <stop offset="1" class="bar-stop-bottom" />
        </linearGradient>
      </defs>
      {props.bars.map((b, i) => {
        const h = barHeight(b.value);
        return (
          <rect x={i * 10 + 1} y={height - h} width={8} height={h} rx={2} class={i === n - 1 ? "bar-now" : "bar"} fill="url(#bar-grad)">
            <title>{b.title}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** One-line hint next to a passkey-confirmed button; without JavaScript it says the action needs it. */
export function PasskeyConfirmNote() {
  return (
    <>
      <p class="small muted passkey-note">Confirm with your passkey.</p>
      <noscript>
        <p class="flash flash-error">{NEEDS_JS}</p>
      </noscript>
    </>
  );
}

/**
 * The parts every `data-passkey-confirm` form carries: the empty `assertion` field that public/admin-passkey.js fills,
 * the slot it writes errors into, and PasskeyConfirmNote. Everything the form binds must be in plain named inputs
 * (no data in the submit button's name or value, no duplicate names, no file inputs).
 */
export function PasskeyConfirm() {
  return (
    <>
      <input type="hidden" name="assertion" value="" />
      <p class="flash flash-error" role="alert" data-passkey-error hidden></p>
      <PasskeyConfirmNote />
    </>
  );
}
