import type { Context, Hono } from "hono";
import { enabledAssets } from "../config";
import { formatFiat } from "../core/money";
import { createLink, linkUrl, listLinks, parseLinkInput, setLinkActive, type LinkRow } from "../links/store";
import { page } from "../web/layout";
import { adminPage, Csrf, NotFoundPage, type AdminEnv } from "./layout";
import { DataTable, EmptyState, Field, Flash, Panel, StatusPill } from "./ui";
import { utc } from "./views";

/*
 * /admin/links: payment links (list, create, deactivate, reactivate; no deletion). Admin session and double-submit CSRF
 * are enforced by the admin middleware before these handlers run. The public side lives in src/links/routes.tsx.
 */

type Ctx = Context<AdminEnv>;
const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");
const SYMBOL: Record<string, string> = { USD: "$", EUR: "€" };

function LinksPage(props: { links: LinkRow[]; publicUrl: string; assets: string[]; csrf: string; error?: string; values?: Record<string, string> }) {
  const v = props.values ?? {};
  return (
    <>
      <Panel id="new" title="New link">
        <form method="post" action="/admin/links" class="form form-wide">
          <Csrf token={props.csrf} />
          {props.error ? <Flash kind="error">{props.error}</Flash> : null}
          <div class="form-row">
            <Field label="Title" name="title" required maxlength={120} placeholder="Donation" value={v.title ?? ""} />
            <Field label="Price" name="amount" mono inputmode="decimal" autocomplete="off" placeholder="25.00" value={v.amount ?? ""} hint="Blank: customer chooses, $1 to $10,000" />
            <Field label="Currency" name="currency">
              <select class="input" name="currency">
                <option value="USD" selected={v.currency !== "EUR"}>USD</option>
                <option value="EUR" selected={v.currency === "EUR"}>EUR</option>
              </select>
            </Field>
          </div>
          <fieldset class="chip-set">
            <legend>Assets (none ticked: every enabled asset)</legend>
            <div class="chip-grid">
              {props.assets.map((a) => (
                <label class="chip">
                  <input type="checkbox" name={`a_${a}`} value="1" checked={v[`a_${a}`] === "1"} /> <span class="mono">{a}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="submit" class="btn cta">
            Create link
          </button>
        </form>
      </Panel>
      <Panel label="Payment links">
        <DataTable
          label="Payment links"
          rows={props.links}
          empty={<EmptyState title="No payment links yet">Create one above and share its URL.</EmptyState>}
          columns={[
            { head: "Title", cell: (l) => l.title },
            { head: "Price", mono: true, nowrap: true, cell: (l) => (l.price_minor === null ? `open (${l.currency})` : `${SYMBOL[l.currency] ?? ""}${formatFiat(l.price_minor)} ${l.currency}`) },
            {
              head: "URL",
              cell: (l) => {
                const url = linkUrl(props.publicUrl, l.id);
                return (
                  <>
                    <span class="mono small">{url}</span>{" "}
                    <button type="button" class="btn2 btn-sm" data-copy={url} aria-label={`Copy link URL for ${l.title}`}>
                      Copy
                    </button>
                  </>
                );
              },
            },
            { head: "Created", cell: (l) => <span class="muted">{utc(l.created_at)}</span> },
            { head: "Status", nowrap: true, cell: (l) => <StatusPill status={l.active ? "paid" : "expired"} label={l.active ? "Active" : "Inactive"} /> },
            {
              head: "Action",
              cell: (l) => (
                <form method="post" action={`/admin/links/${l.id}/active`}>
                  <Csrf token={props.csrf} />
                  <input type="hidden" name="active" value={l.active ? "0" : "1"} />
                  <button type="submit" class="btn2 btn-sm">
                    {l.active ? "Deactivate" : "Reactivate"}
                  </button>
                </form>
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}

export function registerLinks(admin: Hono<AdminEnv>): void {
  const render = async (c: Ctx, extra: { error?: string; values?: Record<string, string> } = {}, status: 200 | 400 = 200) =>
    adminPage(
      c,
      {
        title: "Payment links",
        active: "links",
        scripts: ["/admin.js"],
        actions: (
          <a href="#new" class="btn">
            <span aria-hidden="true">+</span> New link
          </a>
        ),
      },
      <LinksPage links={await listLinks(c.env.DB)} publicUrl={c.env.PUBLIC_URL} assets={enabledAssets(c.env).map((a) => a.id)} csrf={c.get("csrf")} {...extra} />,
      status,
    );

  admin.get("/links", (c) => render(c));

  admin.post("/links", async (c) => {
    const form = await c.req.parseBody();
    const chosen = enabledAssets(c.env).map((a) => a.id).filter((a) => formStr(form, `a_${a}`) === "1");
    const values: Record<string, string> = { title: formStr(form, "title"), amount: formStr(form, "amount").trim(), currency: formStr(form, "currency") };
    for (const a of chosen) values[`a_${a}`] = "1";
    // A ticked box for an asset that is not enabled can't be submitted from the form; extra fields are ignored.
    const p = parseLinkInput(c.env, { title: values.title, price_amount: values.amount, price_currency: values.currency, allowed_assets: chosen.length ? chosen : undefined });
    if (!p.ok) return render(c, { error: p.message, values }, 400);
    await createLink(c.env.DB, p.value);
    return c.redirect("/admin/links", 303);
  });

  admin.post("/links/:id/active", async (c) => {
    const form = await c.req.parseBody();
    const active = formStr(form, "active");
    if (active !== "0" && active !== "1") return render(c, { error: "Invalid request." }, 400);
    if (!(await setLinkActive(c.env.DB, c.req.param("id"), active === "1")))
      return page(c, <NotFoundPage />, 404);
    return c.redirect("/admin/links", 303);
  });
}
