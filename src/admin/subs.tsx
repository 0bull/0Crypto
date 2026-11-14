import type { Context, Hono } from "hono";
import { formatFiat } from "../core/money";
import { createSubscription, deactivateSubscription, listSubscriptions, parseSubscriptionInput, type SubRow } from "../subs/store";
import { page } from "../web/layout";
import { adminPage, Csrf, NotFoundPage, type AdminEnv } from "./layout";
import { DataTable, EmptyState, Field, Flash, Panel, StatusPill } from "./ui";
import { utc } from "./views";

/*
 * /admin/subscriptions: recurring invoices (list, create, deactivate; no deletion). Admin session and double-submit CSRF
 * are enforced by the admin middleware before these handlers run. The cron lives in src/subs/cron.ts. The gateway never
 * emails the customer: the merchant sends the checkout_url from the subscription.invoice_created webhook.
 */

type Ctx = Context<AdminEnv>;
const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");
const SYMBOL: Record<string, string> = { USD: "$", EUR: "€" };

const INTERVALS: [string, string][] = [["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]];
const intervalLabel = (i: string): string => INTERVALS.find(([k]) => k === i)?.[1] ?? i;

function SubsPage(props: { subs: SubRow[]; csrf: string; error?: string; values?: Record<string, string> }) {
  const v = props.values ?? {};
  return (
    <>
      <Panel id="new" title="New subscription">
        <form method="post" action="/admin/subscriptions" class="form form-wide">
          <Csrf token={props.csrf} />
          {props.error ? <Flash kind="error">{props.error}</Flash> : null}
          <div class="form-row">
            <Field label="Label" name="label" required maxlength={120} placeholder="Pro plan" value={v.label ?? ""} />
            <Field label="Amount" name="amount" mono inputmode="decimal" autocomplete="off" required placeholder="19.99" value={v.amount ?? ""} />
            <Field label="Currency" name="currency">
              <select class="input" name="currency">
                <option value="USD" selected={v.currency !== "EUR"}>USD</option>
                <option value="EUR" selected={v.currency === "EUR"}>EUR</option>
              </select>
            </Field>
            <Field label="Interval" name="interval">
              <select class="input" name="interval">
                {INTERVALS.map(([value, label]) => (
                  <option value={value} selected={v.interval === value || (!v.interval && value === "monthly")}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="First invoice (UTC)" name="start" type="datetime-local" mono value={v.start ?? ""} hint="Leave blank to invoice now." />
          <button type="submit" class="btn cta">
            Create subscription
          </button>
        </form>
      </Panel>
      <Panel label="Subscriptions">
        <DataTable
          label="Subscriptions"
          rows={props.subs}
          empty={<EmptyState title="No subscriptions yet">Create one above; each period it makes an invoice and sends a subscription.invoice_created webhook.</EmptyState>}
          columns={[
            { head: "Label", cell: (s) => s.label },
            { head: "Amount", mono: true, nowrap: true, cell: (s) => `${SYMBOL[s.currency] ?? ""}${formatFiat(s.price_minor)} ${s.currency}` },
            { head: "Interval", nowrap: true, cell: (s) => intervalLabel(s.interval) },
            { head: "Next invoice (UTC)", cell: (s) => <span class="muted">{s.active ? utc(s.next_at) : "-"}</span> },
            { head: "Status", nowrap: true, cell: (s) => <StatusPill status={s.active ? "paid" : "expired"} label={s.active ? "Active" : "Inactive"} /> },
            {
              head: "Action",
              cell: (s) =>
                s.active ? (
                  <form method="post" action={`/admin/subscriptions/${s.id}/deactivate`}>
                    <Csrf token={props.csrf} />
                    <button type="submit" class="btn2 btn-sm">
                      Deactivate
                    </button>
                  </form>
                ) : null,
            },
          ]}
        />
      </Panel>
    </>
  );
}

export function registerSubs(admin: Hono<AdminEnv>): void {
  const render = async (c: Ctx, extra: { error?: string; values?: Record<string, string> } = {}, status: 200 | 400 = 200) =>
    adminPage(
      c,
      {
        title: "Subscriptions",
        active: "subs",
        actions: (
          <a href="#new" class="btn">
            <span aria-hidden="true">+</span> New subscription
          </a>
        ),
      },
      <SubsPage subs={await listSubscriptions(c.env.DB)} csrf={c.get("csrf")} {...extra} />,
      status,
    );

  admin.get("/subscriptions", (c) => render(c));

  admin.post("/subscriptions", async (c) => {
    const form = await c.req.parseBody();
    const values: Record<string, string> = {
      label: formStr(form, "label"),
      amount: formStr(form, "amount").trim(),
      currency: formStr(form, "currency"),
      interval: formStr(form, "interval"),
      start: formStr(form, "start").trim(),
    };
    const now = Date.now();
    const p = parseSubscriptionInput({ label: values.label, price_amount: values.amount, price_currency: values.currency, interval: values.interval, start_at: values.start }, now);
    if (!p.ok) return render(c, { error: p.message, values }, 400);
    await createSubscription(c.env.DB, p.value, now);
    return c.redirect("/admin/subscriptions", 303);
  });

  admin.post("/subscriptions/:id/deactivate", async (c) => {
    if (!(await deactivateSubscription(c.env.DB, c.req.param("id"))))
      return page(c, <NotFoundPage />, 404);
    return c.redirect("/admin/subscriptions", 303);
  });
}
