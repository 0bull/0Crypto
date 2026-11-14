import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE, cookieName, secureCookie, sessionGen, verifySession } from "../admin/session";
import { createInvoice, createOrReusePayment, lightningUnavailable } from "../api/invoices";
import { usableAssets } from "../config";
import { clientIpKey } from "../core/ip";
import { formatFiat, parseDecimal } from "../core/money";
import type { AssetId } from "../core/types";
import type { Env } from "../env";
import { PriceUnavailable } from "../prices/cache";
import { publicOrigin } from "../settings";
import { Layout, MerchantBar, merchantName, page } from "../web/layout";
import {
  checkPin,
  getPosConfig,
  IP_MAX_ATTEMPTS,
  maxAgeOf,
  POS_COOKIE,
  posCsrf,
  recentPos,
  releasePosAttempt,
  reservePosAttempt,
  mintPosCookie,
  validPosCsrf,
  verifyPosCookie,
  type RecentInvoice,
} from "./store";

/*
 * /pos: a counter-top page for taking card-present style crypto payments. Authentication is an admin session or a POS
 * session (cookie `0c_pos`, set after a PIN login or by the admin panel's "Open POS"). Every POST is a same-origin form
 * post carrying a CSRF token bound to the session cookie. The page only ever creates invoices and shows their status:
 * it never reads addresses, customers or balances.
 */

type PosEnv = { Bindings: Env };
type Ctx = Context<PosEnv>;
export const pos = new Hono<PosEnv>();

const cookieOpts = (c: Ctx) => ({ secure: secureCookie(c.req.url), sameSite: "Strict", path: "/pos", httpOnly: true }) as const;

/** Currency -> minor digits. Same figures as payment links: 0.01 to 10,000 in the currency's own units. */
const MINOR_DIGITS: Record<string, number> = { USD: 2, EUR: 2 };
const CURRENCIES = Object.keys(MINOR_DIGITS);
const MAX_UNITS = 10_000n;
const SYMBOL: Record<string, string> = { USD: "$", EUR: "€" };

export function parseAmount(raw: string, currency: string): bigint | null {
  if (!Object.hasOwn(MINOR_DIGITS, currency)) return null;
  const digits = MINOR_DIGITS[currency]!;
  let v: bigint;
  try {
    v = parseDecimal(raw.trim(), digits); // plain decimal only, no exponent, sign or separators
  } catch {
    return null;
  }
  return v >= 1n && v <= MAX_UNITS * 10n ** BigInt(digits) ? v : null;
}

// ---------- gates ----------

// Refuse to serve anything while the signing secret is missing or weak (<32 bytes).
pos.use("*", async (c, next) => {
  if (new TextEncoder().encode(c.env.SESSION_SECRET ?? "").length < 32) return page(c, <Frame env={c.env} title="Not configured"><h1>POS unavailable</h1><p class="muted">The gateway is not fully configured.</p></Frame>, 503);
  return next();
});

/**
 * The client's rate-limit key (an IPv6 /64 is one client, see core/ip.ts), for the per-IP budget on the shared API
 * limiter (unauthenticated requests and charges) and the PIN lockout. The IP is only a key.
 */
const ipOf = (c: Ctx) => clientIpKey(c);
const limited = async (c: Ctx): Promise<boolean> => !(await c.env.API_RATE.limit({ key: "pos:" + ipOf(c) })).success;

/**
 * Cross-site posts: the Origin, when the browser sends one, must be this gateway. Missing Origin passes (CSRF tokens
 * still apply). With no usable PUBLIC_URL yet (before the first claim) every post counts as cross-origin.
 */
const crossOrigin = (c: Ctx): boolean => {
  const own = publicOrigin(c.env);
  const o = c.req.header("origin");
  return own === null || (o !== undefined && o !== own);
};

interface Session {
  /** The cookie value the CSRF token is bound to. */
  binder: string;
}

/** A valid POS cookie, or a valid admin session cookie (Path=/, so a signed-in admin's browser sends it here too). */
async function sessionOf(c: Ctx): Promise<Session | null> {
  const now = Date.now();
  const secret = c.env.SESSION_SECRET;
  const posRaw = getCookie(c, POS_COOKIE);
  if (posRaw && (await verifyPosCookie(secret, posRaw, await getPosConfig(c.env.DB), now))) return { binder: posRaw };
  const adm = getCookie(c, cookieName(SESSION_COOKIE, c.req.url));
  if (adm && (await verifySession(secret, adm, now, await sessionGen(c.env.DB)))) return { binder: adm };
  return null;
}

// ---------- views ----------

function Frame(props: { env: Env; title: string; scripts?: string[]; children: unknown }) {
  const name = merchantName(props.env);
  return (
    <Layout title={`${props.title} · ${name}`} css={["/checkout.css", "/pos.css"]} scripts={props.scripts}>
      <div class="page">
        <MerchantBar name={name} />
        {props.children as never}
      </div>
    </Layout>
  );
}

const utc = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

function RecentList(props: { items: RecentInvoice[] }) {
  return (
    <ul class="recent" id="pos-recent" data-empty="No POS invoices yet.">
      {props.items.length === 0 ? <li class="muted small">No POS invoices yet.</li> : null}
      {props.items.map((i) => (
        <li class="recent-row">
          <span class="mono recent-amt">
            {i.amount} {i.currency}
          </span>
          <span class={`pill pill-${i.status}`}>{i.status.replaceAll("_", " ")}</span>
          <time class="muted tiny" datetime={i.created_at}>
            {utc(i.created_at)}
          </time>
        </li>
      ))}
    </ul>
  );
}

function LoginView(props: { env: Env; pinSet: boolean; error?: string }) {
  return (
    <Frame env={props.env} title="POS sign in">
      <section class="card checkout-card">
        <h1 class="headline">POS</h1>
        {props.pinSet ? (
          <form method="post" action="/pos/login" class="pos-form">
            {props.error ? <p class="warn" role="alert">{props.error}</p> : null}
            <label class="pos-label">
              PIN
              <input class="pos-input mono" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" required />
            </label>
            <button type="submit" class="btn pos-go">Unlock</button>
          </form>
        ) : (
          <>
            {props.error ? <p class="warn" role="alert">{props.error}</p> : null}
            <p class="muted">PIN sign-in is not set up. Sign in to the admin panel to open the POS, or set a PIN under POS settings.</p>
            <a class="btn2 pos-link" href="/admin/pos">Admin panel</a>
          </>
        )}
      </section>
    </Frame>
  );
}

interface Draft {
  amount?: string;
  currency?: string;
  asset?: string;
  error?: string;
}

function KeypadView(props: { env: Env; csrf: string; assets: { id: string; symbol: string; chain: string }[]; recent: RecentInvoice[]; draft: Draft }) {
  const d = props.draft;
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"];
  return (
    <Frame env={props.env} title="POS" scripts={["/pos.js"]}>
      <section class="card checkout-card">
        <form method="post" action="/pos/charge" class="pos-form" id="pos-form">
          <input type="hidden" name="csrf" value={props.csrf} />
          {d.error ? <p class="warn" role="alert">{d.error}</p> : null}
          <label class="pos-label">
            Amount
            <input class="pos-input pos-amount mono" id="pos-amount" name="amount" inputmode="decimal" autocomplete="off" required placeholder="0.00" value={d.amount ?? ""} />
          </label>
          <div class="pos-row">
            <label class="pos-label">
              Currency
              <select class="pos-input" name="currency">
                {CURRENCIES.map((cur) => (
                  <option value={cur} selected={cur === (d.currency ?? "USD")}>
                    {cur} {SYMBOL[cur]}
                  </option>
                ))}
              </select>
            </label>
            <label class="pos-label">
              Pay with
              <select class="pos-input" name="asset">
                <option value="" selected={!d.asset}>Customer chooses</option>
                {props.assets.map((a) => (
                  <option value={a.id} selected={a.id === d.asset}>
                    {a.symbol} ({a.chain})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div class="keypad" id="pos-keypad" aria-label="Amount keypad">
            {keys.map((k) => (
              <button type="button" class="btn2 key" data-k={k}>
                {k}
              </button>
            ))}
            <button type="button" class="btn2 key" data-k="back" aria-label="Delete last digit">
              &#9003;
            </button>
          </div>
          <button type="submit" class="btn pos-go">
            Charge
          </button>
        </form>
      </section>
      <section class="card checkout-card" aria-label="Recent invoices">
        <h2 class="pos-h2">Recent</h2>
        <RecentList items={props.recent} />
        <p class="muted tiny" id="pos-recent-note">Updates every few seconds while this page is open.</p>
      </section>
      <form method="post" action="/pos/logout" class="pos-logout">
        <input type="hidden" name="csrf" value={props.csrf} />
        <button type="submit" class="btn2 pos-link">Lock</button>
      </form>
    </Frame>
  );
}

async function renderKeypad(c: Ctx, s: Session, draft: Draft = {}, status: 200 | 400 = 200): Promise<Response> {
  const [recent, assets] = await Promise.all([recentPos(c.env.DB), usableAssets(c.env)]);
  return page(c, <KeypadView env={c.env} csrf={await posCsrf(c.env.SESSION_SECRET, s.binder)} assets={assets.map((a) => ({ id: a.id, symbol: a.symbol, chain: a.chain }))} recent={recent} draft={draft} />, status);
}

const tooMany = (c: Ctx, msg = "Too many attempts. Try again later.") => page(c, <LoginView env={c.env} pinSet error={msg} />, 429);
const forbidden = (c: Ctx) =>
  page(c, <Frame env={c.env} title="Forbidden"><section class="card checkout-card"><h1 class="headline">Request rejected</h1><p class="muted">The form expired. Go back, reload the page and try again.</p></section></Frame>, 403);

// ---------- routes ----------

pos.get("/", async (c) => {
  const s = await sessionOf(c);
  if (s) return renderKeypad(c, s);
  if (await limited(c)) return tooMany(c);
  return page(c, <LoginView env={c.env} pinSet={(await getPosConfig(c.env.DB)).pin_hash !== null} />);
});

pos.post("/login", async (c) => {
  if (crossOrigin(c)) return forbidden(c);
  if (await limited(c)) return tooMany(c);
  const cfg = await getPosConfig(c.env.DB);
  // No PIN set: PIN login does not exist (only an admin session reaches the POS). Nothing to hash or count.
  if (!cfg.pin_hash) return page(c, <LoginView env={c.env} pinSet={false} error="PIN sign-in is not available." />, 401);
  // Reserve a slot (per address and global) before any PBKDF2 runs; over a limit or any D1 error: 429, no PIN check.
  let slot;
  try {
    slot = await reservePosAttempt(c.env, ipOf(c));
  } catch {
    return tooMany(c);
  }
  if (!slot.ok) return tooMany(c);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const pin = typeof form.pin === "string" ? form.pin : "";
  if (!(await checkPin(cfg, pin))) return slot.ipN >= IP_MAX_ATTEMPTS ? tooMany(c) : page(c, <LoginView env={c.env} pinSet error="Wrong PIN." />, 401);
  await releasePosAttempt(c.env, slot).catch(() => undefined); // best effort; the PIN was right
  setCookie(c, POS_COOKIE, await mintPosCookie(c.env.SESSION_SECRET, "p", cfg.version, Date.now() + maxAgeOf("p") * 1000), { ...cookieOpts(c), maxAge: maxAgeOf("p") });
  return c.redirect("/pos", 303);
});

pos.post("/logout", async (c) => {
  const s = await sessionOf(c);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  if (s && !crossOrigin(c) && (await validPosCsrf(c.env.SESSION_SECRET, s.binder, typeof form.csrf === "string" ? form.csrf : ""))) deleteCookie(c, POS_COOKIE, { path: "/pos" });
  return c.redirect("/pos", 303);
});

pos.post("/charge", async (c) => {
  const s = await sessionOf(c);
  if (!s) return page(c, <LoginView env={c.env} pinSet={(await getPosConfig(c.env.DB)).pin_hash !== null} error="Sign in first." />, 401);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  if (crossOrigin(c) || !(await validPosCsrf(c.env.SESSION_SECRET, s.binder, str("csrf")))) return forbidden(c);
  if (await limited(c)) return tooMany(c, "Too many requests. Wait a minute and try again.");

  const draft: Draft = { amount: str("amount").slice(0, 20), currency: str("currency"), asset: str("asset").slice(0, 40) };
  const fail = (error: string) => renderKeypad(c, s, { ...draft, error }, 400);
  if (!Object.hasOwn(MINOR_DIGITS, draft.currency!)) return fail("Choose a currency.");
  const minor = parseAmount(str("amount"), draft.currency!);
  if (minor === null) return fail(`Enter an amount from ${SYMBOL[draft.currency!] ?? ""}0.01 to ${SYMBOL[draft.currency!] ?? ""}10,000.00, like 12.50.`);
  // Validate the asset before any invoice exists: it must be enabled and usable now (a chain that cannot be swept is not offered).
  let asset: AssetId | null = null;
  if (draft.asset) {
    const ok = (await usableAssets(c.env)).find((a) => a.id === draft.asset);
    if (!ok) return fail("That asset is not available.");
    asset = ok.id;
  }

  const r = await createInvoice(c.env, { price_amount: formatFiat(minor), price_currency: draft.currency, metadata: { pos: true } });
  if ("error" in r) return fail("Could not create the invoice.");
  const id = r.invoice.id;
  if (asset === null) return c.redirect(`/i/${id}`, 303);
  try {
    const p = await createOrReusePayment(c.env, id, asset, ipOf(c));
    if (!("error" in p)) return c.redirect(`/i/${id}/p/${p.body.payment_id}`, 303);
  } catch (e) {
    // No fresh price, or the Lightning wallet did not answer (relay down, timeout, refused connection): same as checkout.
    if (!(e instanceof PriceUnavailable) && !lightningUnavailable(e)) throw e;
  }
  // The invoice exists; the payment could not be started (no fresh price, wallet down, rate limit...). The choice page lets
  // the customer retry or pick another asset.
  return c.redirect(`/i/${id}`, 303);
});

pos.get("/recent", async (c) => {
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  if (!(await sessionOf(c))) return c.json({ error: "unauthorized" }, 401);
  return c.json({ invoices: await recentPos(c.env.DB) });
});
