import { Hono, type Context } from "hono";
import { hmacHex, safeEqual } from "../admin/session";
import { apiError } from "../api/errors";
import { requireApiKey } from "../api/auth";
import { parsePage } from "../api/page";
import { createInvoice } from "../api/invoices";
import { usableAssets } from "../config";
import { clientIpKey } from "../core/ip";
import { formatFiat, parseDecimal } from "../core/money";
import type { AssetId } from "../core/types";
import type { Env } from "../env";
import { publicOrigin } from "../settings";
import { Layout, MerchantBar, merchantName, page } from "../web/layout";
import { createLink, getLink, listLinksPage, OPEN_MAX_MINOR, OPEN_MIN_MINOR, parseLinkInput, reserveLinkBudget, serializeLink, setLinkActive, type LinkRow } from "./store";

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€" };
const TOKEN_TTL_MS = 3_600_000;

/**
 * Signed, expiring, link-bound form token: `<exp ms>.<hex hmac(SESSION_SECRET, "link-form:<id>:<exp>")>`.
 * It only proves this gateway served the link's Pay form within the last hour. It is not bound to a browser or
 * user (the form is public, there is no session), so it does not stop one visitor passing it to another; the per-IP rate
 * limit and the link budget cover that. Its job is to keep blind cross-site and scripted posts from creating invoices.
 */
const formToken = async (env: Env, id: string, now: number) => {
  const exp = now + TOKEN_TTL_MS;
  return `${exp}.${await hmacHex(env.SESSION_SECRET, `link-form:${id}:${exp}`)}`;
};
async function validFormToken(env: Env, id: string, token: string, now: number): Promise<boolean> {
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[1]) < now) return false;
  return safeEqual(await hmacHex(env.SESSION_SECRET, `link-form:${id}:${m[1]}`), m[2]!);
}

export const links = new Hono<{ Bindings: Env }>();

function Frame(props: { env: Env; title: string; children: unknown }) {
  const name = merchantName(props.env);
  return (
    <Layout title={`${props.title} · ${name}`} css={["/checkout.css"]}>
      <div class="page">
        <MerchantBar name={name} />
        <section class="card pad">{props.children as never}</section>
      </div>
    </Layout>
  );
}

// One body for unknown and inactive links (and malformed ids), so nothing tells them apart.
const notFound = (c: Context<{ Bindings: Env }>) =>
  page(c, <Frame env={c.env} title="Not found"><h1>Link not found</h1><p class="muted">This payment link does not exist or is no longer active.</p></Frame>, 404);
const unavailable = (c: Context<{ Bindings: Env }>) =>
  page(c, <Frame env={c.env} title="Unavailable"><h1>Payments unavailable</h1><p class="muted">This payment link is temporarily unavailable. Please try again later or contact the merchant.</p></Frame>, 503);
const tooMany = (c: Context<{ Bindings: Env }>) =>
  page(c, <Frame env={c.env} title="Slow down"><h1>Too many requests</h1><p class="muted">Please wait a minute and try again.</p></Frame>, 429);

/**
 * The link's page: title, the price (fixed link) or an amount field (open link), and a Pay button. Showing it creates
 * nothing, so link previews, crawlers and reloads are harmless; only the POST of this form creates an invoice.
 */
function PayForm(props: { env: Env; link: LinkRow; token: string; error?: string; value?: string }) {
  const sym = SYMBOL[props.link.currency] ?? "";
  const fixed = props.link.price_minor;
  return (
    <Frame env={props.env} title={props.link.title}>
      <h1>{props.link.title}</h1>
      <form method="post" action={`/l/${props.link.id}`} class="form">
        <input type="hidden" name="token" value={props.token} />
        {props.error ? <p class="error" role="alert">{props.error}</p> : null}
        {fixed !== null ? (
          <p class="mono">
            {sym}
            {formatFiat(fixed)} {props.link.currency}
          </p>
        ) : (
          <label>
            Amount ({props.link.currency}, {sym}{formatFiat(OPEN_MIN_MINOR)} to {sym}{formatFiat(OPEN_MAX_MINOR)})
            <input class="field mono" name="amount" inputmode="decimal" autocomplete="off" required value={props.value ?? ""} />
          </label>
        )}
        <button type="submit" class="btn cta">Pay</button>
      </form>
    </Frame>
  );
}

/** Creates one invoice for this submit and 303s to its checkout. Nothing here reads other invoices. */
async function openInvoice(c: Context<{ Bindings: Env }>, link: LinkRow, price: bigint): Promise<Response> {
  // Only assets the gateway can serve right now (usableAssets: enabled, and e.g. not a refused Lightning wallet).
  const usable = new Set((await usableAssets(c.env)).map((a) => a.id));
  let allowed: AssetId[] | undefined;
  if (link.allowed_assets) {
    allowed = link.allowed_assets.filter((a) => usable.has(a));
    if (allowed.length === 0) return unavailable(c);
  } else if (usable.size === 0) return unavailable(c);
  // The invoice budget (per link, then global), reserved only for a submit that would create an invoice. A D1 error is
  // a refusal (fail closed).
  let budget;
  try {
    budget = await reserveLinkBudget(c.env.DB, link.id);
  } catch {
    return unavailable(c);
  }
  if (!budget.ok) return tooMany(c);
  const r = await createInvoice(c.env, {
    price_amount: formatFiat(price),
    price_currency: link.currency,
    metadata: { link_id: link.id },
    ...(allowed ? { allowed_assets: allowed } : {}),
  });
  if ("error" in r) return unavailable(c);
  return c.redirect(`/i/${r.invoice.id}`, 303);
}

/** Per-IP budget (an IPv6 /64 is one client) on the shared API limiter, for page views and submits. The IP is only a key. */
const limited = async (c: Context<{ Bindings: Env }>): Promise<boolean> => !(await c.env.API_RATE.limit({ key: "link:" + clientIpKey(c) })).success;

links.get("/l/:id", async (c) => {
  if (await limited(c)) return tooMany(c);
  const link = await getLink(c.env.DB, c.req.param("id"));
  if (!link || !link.active) return notFound(c);
  // Hono dispatches HEAD to this GET handler (the raw request keeps its method); answer headers only.
  if (c.req.raw.method === "HEAD") return page(c, <Frame env={c.env} title={link.title}>{null}</Frame>);
  return page(c, <PayForm env={c.env} link={link} token={await formToken(c.env, link.id, Date.now())} />);
});

links.post("/l/:id", async (c) => {
  if (await limited(c)) return tooMany(c);
  const link = await getLink(c.env.DB, c.req.param("id"));
  if (!link || !link.active) return notFound(c);
  const forbidden = () =>
    page(c, <Frame env={c.env} title="Forbidden"><h1>Request rejected</h1><p class="muted">The form expired. Go back, reload the page and try again.</p></Frame>, 403);
  // Cross-site posts: browsers send Origin on cross-origin POSTs, and it must be this gateway. A missing Origin fails OPEN
  // on purpose: some clients and privacy tools strip it, and refusing them would block real customers; the signed token,
  // the per-IP rate limit and the link budget still apply to those requests. With no usable PUBLIC_URL yet (before the
  // first claim) every post is refused.
  const own = publicOrigin(c.env);
  const origin = c.req.header("origin");
  if (own === null || (origin !== undefined && origin !== own)) return forbidden();
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  if (!(await validFormToken(c.env, link.id, token, Date.now()))) return forbidden();
  // A fixed link charges its own price; any posted amount is ignored.
  if (link.price_minor !== null) return openInvoice(c, link, link.price_minor);
  const raw = typeof form.amount === "string" ? form.amount : "";
  let price: bigint | null = null;
  try {
    price = parseDecimal(raw, 2); // plain decimal only, at most 2 fraction digits
  } catch {
    price = null;
  }
  if (price === null || price < OPEN_MIN_MINOR || price > OPEN_MAX_MINOR) {
    const sym = SYMBOL[link.currency] ?? "";
    return page(c, <PayForm env={c.env} link={link} token={await formToken(c.env, link.id, Date.now())} value={raw.slice(0, 20)} error={`Enter an amount from ${sym}${formatFiat(OPEN_MIN_MINOR)} to ${sym}${formatFiat(OPEN_MAX_MINOR)}, like 25.00.`} />, 400);
  }
  return openInvoice(c, link, price);
});

// ---------- JSON API: /api/v1/links ----------

export const linksApi = new Hono<{ Bindings: Env }>();
linksApi.onError((e, c) => {
  console.error("api error:", e instanceof Error ? e.name : "Error");
  return apiError(c, "internal_error", "internal error");
});

linksApi.post("/", requireApiKey, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_request", "body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return apiError(c, "invalid_request", "body must be a JSON object");
  const b = body as Record<string, unknown>;
  const p = parseLinkInput(c.env, { title: b.title, price_amount: b.price_amount, price_currency: b.price_currency, allowed_assets: b.allowed_assets });
  if (!p.ok) return apiError(c, "invalid_request", p.message);
  return c.json(serializeLink(await createLink(c.env.DB, p.value), c.env.PUBLIC_URL), 201);
});

linksApi.get("/", requireApiKey, async (c) => {
  const p = parsePage((k) => c.req.query(k));
  if (!p.ok) return apiError(c, "invalid_request", p.message);
  const { links: rows, next } = await listLinksPage(c.env.DB, p.page);
  return c.json({ links: rows.map((l) => serializeLink(l, c.env.PUBLIC_URL)), next_cursor: next });
});

linksApi.patch("/:id", requireApiKey, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_request", "body must be valid JSON");
  }
  const active = typeof body === "object" && body !== null ? (body as Record<string, unknown>).active : undefined;
  if (typeof active !== "boolean") return apiError(c, "invalid_request", "active must be a boolean");
  if (!(await setLinkActive(c.env.DB, c.req.param("id"), active))) return apiError(c, "not_found", "link not found");
  return c.json(serializeLink((await getLink(c.env.DB, c.req.param("id")))!, c.env.PUBLIC_URL));
});
