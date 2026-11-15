import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { createInvoice } from "../api/invoices";
import { EVM_CHAINS, isEvmChain, type EvmChain } from "../chains/evm/config";
import { chainConfigError } from "../chains/registry";
import { evmHotAddress, solHotAddress, tronHotAddress } from "../signing/addresses";
import { listUnresolvedAlerts, resolveAlert } from "../db/alerts";
import { failStuckSweep, listStuckSweeps } from "../db/sweeps";
import { getEvent, getInvoice, getPayment, listPayments, listUnexpectedDeposits } from "../db/repo";
import type { Env } from "../env";
import { isTokenAddress, recoveredPaymentIds, recoveryBlock, recoverDeposit } from "../sweep/evm";
import { enqueueEvents } from "../webhooks/outbox";
import { page } from "../web/layout";
import { registerAuth } from "./auth";
import { confirmProblem, registerConfirm } from "./confirm";
import { adminPage, AuthShell, NotFoundPage, NAV_GROUPS, NAV_ICON, Csrf, type AdminEnv } from "./layout";
import { Flash, Icon, Panel } from "./ui";
import { registerLinks } from "./links";
import { registerDevelopers } from "./developers";
import { registerPasskeys } from "./passkeys";
import { httpsUpgrade } from "./rp";
import { registerPos } from "./pos";
import { registerSubs } from "./subs";
import { registerRefunds } from "./refunds";
import { registerRouting } from "./routing";
import { registerSettings } from "./settings";
import { registerWelcome } from "./welcome";
import { loadChecklist } from "./checklist";
import { SESSION_COOKIE, SETUP_COOKIE, SETUP_MAX_AGE, cookieAttrs, cookieName, csrfFor, newSetupBinder, safeEqual, validSetupBinder, verifySession } from "./session";
import { loadDashboard, loadEventsAndDeliveries, loadInvoices, parsePeriod, parseStatus } from "./stats";
import { DashboardActions, DashboardPage, InvoiceDetailActions, InvoiceDetailPage, InvoicesPage, invoiceFormError, NewInvoiceButton, NewInvoicePage, type RoutedHotWallet, WalletsPage, type WatchWallet } from "./views";

export type { AdminEnv } from "./layout";
type Ctx = Context<AdminEnv>;

export const admin = new Hono<AdminEnv>();

/** Reachable while no passkey exists (everything else redirects here); 404 once one does. */
const SETUP_PATHS = new Set(["/admin/setup", "/admin/setup/options", "/admin/setup/code"]);
/** Reachable without a session once the gateway is claimed. */
const PUBLIC_PATHS = new Set(["/admin/login", "/admin/login/options", "/admin/recover", "/admin/recover/options"]);

// Plain http only on a loopback host (local development): anywhere else the admin answers 308 to https first, so no
// cookie, form or passkey ceremony ever happens over http on a public host.
admin.use("*", async (c, next) => {
  const to = httpsUpgrade(c.req.url);
  return to === null ? next() : c.redirect(to, 308);
});

// Refuse to serve anything while the signing secret is missing or weak (<32 bytes).
admin.use("*", async (c, next) => {
  if (new TextEncoder().encode(c.env.SESSION_SECRET ?? "").length < 32) {
    c.header("cache-control", "no-store");
    return page(c, <NotConfigured />, 503);
  }
  return next();
});

// Every admin response is uncacheable, including redirects and errors.
admin.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});

const notFound = (c: Ctx) =>
  page(c, <NotFoundPage />, 404);

/*
 * The gate, then session and CSRF. Fail closed: while no passkey exists, every admin path but the three setup ones
 * redirects to /admin/setup; once one exists, the setup paths are gone (404) and everything but the sign-in and
 * recovery paths needs a session.
 *
 * The token in every form is HMAC(SESSION_SECRET, "csrf:" + binder), where the binder is the valid session cookie, or
 * before sign-in the random HttpOnly `0c_setup` cookie (minted here when missing or malformed). A token therefore only
 * works next to the cookie it was made for: a pre-auth token stops working once signed in, and a session's tokens die
 * with it (expiry or a session_gen bump).
 */
admin.use("*", createMiddleware<AdminEnv>(async (c, next) => {
  const state = await c.env.DB.prepare("SELECT session_gen AS gen, EXISTS (SELECT 1 FROM passkeys) AS claimed FROM admin_state WHERE id=1").first<{ gen: number; claimed: number }>();
  const gen = state?.gen ?? 0;
  const path = c.req.path.replace(/\/$/, "");
  if (state?.claimed !== 1) {
    if (!SETUP_PATHS.has(path)) return c.redirect("/admin/setup", 302);
  } else if (path === "/admin/setup" || path.startsWith("/admin/setup/")) {
    return notFound(c);
  }

  const secret = c.env.SESSION_SECRET;
  const url = c.req.url;
  const raw = getCookie(c, cookieName(SESSION_COOKIE, url));
  const session = raw !== undefined && (await verifySession(secret, raw, Date.now(), gen)) ? raw : null;
  c.set("session", session);
  let binder = session;
  if (binder === null) {
    const setup = getCookie(c, cookieName(SETUP_COOKIE, url));
    binder = validSetupBinder(setup) ? setup : newSetupBinder();
    if (binder !== setup) setCookie(c, cookieName(SETUP_COOKIE, url), binder, { ...cookieAttrs(url), httpOnly: true, maxAge: SETUP_MAX_AGE });
  }
  const expected = await csrfFor(secret, binder);
  c.set("csrf", expected);
  if (c.req.method === "POST") {
    const form = await c.req.parseBody();
    const sent = typeof form.csrf === "string" ? form.csrf : "";
    if (!safeEqual(sent, expected)) return page(c, <Forbidden />, 403);
  }
  if (session === null && !SETUP_PATHS.has(path) && !PUBLIC_PATHS.has(path)) return c.redirect("/admin/login", 302);
  await next();
}));

function NotConfigured() {
  return (
    <AuthShell title="Not configured">
      <h1 class="auth-title">Admin unavailable</h1>
      <p class="muted">SESSION_SECRET is missing or too short (32 bytes minimum).</p>
      <p class="muted small">Set a SESSION_SECRET of at least 32 bytes in the Worker's secrets, then reload this page.</p>
    </AuthShell>
  );
}

function Forbidden() {
  return (
    <AuthShell title="Forbidden">
      <h1 class="auth-title">Request rejected</h1>
      <p class="muted">The security token was missing or did not match. Go back, reload the page and try again.</p>
      <p class="auth-links small">
        <a href="/admin">Back to the dashboard</a>
      </p>
    </AuthShell>
  );
}

const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");

// ---------- setup, sign-in, recovery, sign-out (auth.tsx) ----------

registerAuth(admin);

// ---------- dashboard ----------

admin.get("/", async (c) => {
  const now = Date.now();
  const [d, alerts, stuck, { list: unexpected, recovered }, checklist] = await Promise.all([
    loadDashboard(c.env.DB, parsePeriod(c.req.query("p")), now),
    listUnresolvedAlerts(c.env.DB),
    listStuckSweeps(c.env.DB, now),
    listUnexpectedDeposits(c.env.DB).then(async (list) => ({ list, recovered: await recoveredPaymentIds(c.env.DB, list) })),
    loadChecklist(c.env),
  ]);
  return adminPage(
    c,
    { title: "Overview", active: "overview", actions: <DashboardActions period={d.period} /> },
    <DashboardPage d={d} alerts={alerts} stuckSweeps={stuck} unexpected={unexpected} recovered={recovered} checklist={checklist} csrf={c.get("csrf")} />,
  );
});

// A sweep tx that has been pending for over an hour (and cannot be fixed by fee bumps) can be written off by hand
// (passkey confirmation "sweep.fail", bound to this sweep's path).
admin.post("/sweeps/:id/fail", async (c) => {
  if (!(await c.env.DB.prepare("SELECT 1 AS x FROM sweeps WHERE id=?").bind(c.req.param("id")).first())) return notFound(c);
  const problem = await confirmProblem(c, await c.req.parseBody(), "sweep.fail");
  if (problem)
    return adminPage(c, { title: "Sweeps", active: "privacy" }, <><Flash kind="error">{problem}</Flash><p><a href="/admin">Back to the overview</a></p></>, 403);
  const r = await failStuckSweep(c.env.DB, c.req.param("id"), Date.now());
  if (r === "not_found") return notFound(c);
  if (r === "not_stuck")
    return adminPage(c, { title: "Sweeps", active: "privacy" }, <><Flash kind="error">Only a pending sweep whose last broadcast is over an hour old (or that used up its fee bumps) can be marked failed.</Flash><p><a href="/admin">Back to the overview</a></p></>, 409);
  return c.redirect("/admin", 303);
});

admin.post("/alerts/:id/resolve", async (c) => {
  await resolveAlert(c.env.DB, c.req.param("id"), Date.now());
  return c.redirect("/admin", 303);
});

// ---------- wallets (was /admin/chains) ----------

const configuredEvmChains = (env: Env): EvmChain[] => (Object.keys(EVM_CHAINS) as EvmChain[]).filter((ch) => chainConfigError(env, ch) === null);

admin.get("/chains", (c) => c.redirect("/admin/wallets", 301));

admin.get("/wallets", async (c) => {
  const configured = configuredEvmChains(c.env);
  const chains = [];
  if (configured.length > 0) {
    const [{ evmHealthDetail }, hotAddress] = await Promise.all([import("../chains/evm/health"), evmHotAddress(c.env)]);
    const rows = await Promise.all(configured.map(async (ch) => ({ ch, d: await evmHealthDetail(c.env, ch) })));
    for (const { ch, d } of rows)
      chains.push({ chain: ch, symbol: EVM_CHAINS[ch].nativeSymbol, hotAddress, ...d.value, staleSince: d.stale ? d.checkedAt : null, error: d.error });
  }
  // Tron and Solana hot wallets, so operators can fund them: addresses only (derived from MASTER_SEED), no balance read.
  const hot: RoutedHotWallet[] = [];
  if (chainConfigError(c.env, "tron") === null) hot.push({ chain: "tron", address: tronHotAddress(c.env.MASTER_SEED ?? "") });
  if (chainConfigError(c.env, "sol") === null) hot.push({ chain: "sol", address: solHotAddress(c.env.MASTER_SEED ?? "") });
  const watch: WatchWallet[] = [
    { name: "Bitcoin", xpub: c.env.BTC_XPUB || null, startIndex: c.env.BTC_XPUB_START_INDEX ?? "" },
    { name: "Litecoin", xpub: c.env.LTC_XPUB || null, startIndex: c.env.LTC_XPUB_START_INDEX ?? "" },
    { name: "Dogecoin", xpub: c.env.DOGE_XPUB || null, startIndex: c.env.DOGE_XPUB_START_INDEX ?? "" },
  ];
  // A chain that has everything but MASTER_SEED says so, rather than silently missing from the tables.
  const disabled = ([...(Object.keys(EVM_CHAINS) as EvmChain[]), "tron", "sol"] as const)
    .map((ch) => ({ chain: ch === "tron" ? "Tron" : ch === "sol" ? "Solana" : ch, reason: chainConfigError(c.env, ch) }))
    .filter((d): d is { chain: string; reason: string } => d.reason === "MASTER_SEED is not set");
  return adminPage(c, { title: "Wallets", active: "wallets" }, <WalletsPage chains={chains} hotWallets={hot} watch={watch} disabled={disabled} />);
});

// ---------- invoices ----------

admin.get("/invoices", async (c) => {
  const status = parseStatus(c.req.query("status"));
  const now = Date.now();
  const rows = await loadInvoices(c.env.DB, status, now);
  return adminPage(c, { title: "Invoices", active: "invoices", actions: <NewInvoiceButton /> }, <InvoicesPage rows={rows} status={status} now={now} />);
});

admin.get("/invoices/new", (c) => adminPage(c, { title: "New invoice", active: "invoices" }, <NewInvoicePage csrf={c.get("csrf")} />));

admin.post("/invoices/new", async (c) => {
  const form = await c.req.parseBody();
  const values = {
    amount: formStr(form, "amount").trim(),
    currency: formStr(form, "currency"),
    order_id: formStr(form, "order_id").trim(),
    expiry_minutes: formStr(form, "expiry_minutes").trim(),
  };
  const fail = (message: string) => {
    const { text, field } = invoiceFormError(message);
    return adminPage(c, { title: "New invoice", active: "invoices" }, <NewInvoicePage csrf={c.get("csrf")} error={text} errorField={field} values={values} />, 400);
  };
  const input: Record<string, unknown> = { price_amount: values.amount, price_currency: values.currency };
  if (values.order_id) input.order_id = values.order_id;
  if (values.expiry_minutes) {
    if (!/^\d{1,4}$/.test(values.expiry_minutes)) return fail("expires_in_sec must be a whole number of minutes");
    input.expires_in_sec = Number(values.expiry_minutes) * 60;
  }
  const r = await createInvoice(c.env, input);
  if ("error" in r) return fail(r.error);
  return c.redirect(`/admin/invoices/${r.invoice.id}`, 303);
});

admin.get("/invoices/:id", async (c) => {
  const inv = await getInvoice(c.env.DB, c.req.param("id"));
  if (!inv) return notFound(c);
  const [payments, { events, deliveries }] = await Promise.all([listPayments(c.env.DB, inv.id), loadEventsAndDeliveries(c.env.DB, inv.id)]);
  const recovery = c.req.query("recovery");
  const rchain = c.req.query("chain");
  const notice: { status: "sent" | "skipped" | "failed"; chain: string } | undefined =
    recovery === "sent" || recovery === "skipped" || recovery === "failed"
      ? { status: recovery, chain: rchain && Object.hasOwn(EVM_CHAINS, rchain) ? rchain : "" }
      : undefined;
  return adminPage(
    c,
    { title: "Invoice", active: "invoices", actions: <InvoiceDetailActions id={inv.id} /> },
    <InvoiceDetailPage inv={inv} payments={payments} events={events} deliveries={deliveries} csrf={c.get("csrf")} now={Date.now()} recoverChains={configuredEvmChains(c.env)} notice={notice} />,
  );
});

// Wrong-chain recovery: the customer sent funds to this payment's address on another chain. Flushes the payment's
// forwarder on the chosen chain; the payment itself is not marked swept.
admin.post("/payments/:id/recover", async (c) => {
  const p = await getPayment(c.env.DB, c.req.param("id"));
  if (!p) return notFound(c);
  const form = await c.req.parseBody();
  const chain = formStr(form, "chain");
  const token = formStr(form, "token").trim();
  const mode = formStr(form, "tokens") || "all";
  const fail400 = (message: string) =>
    adminPage(c, { title: "Recover deposit", active: "invoices" }, <><Flash kind="error">{message}</Flash><p><a href={`/admin/invoices/${p.invoice_id}`}>Back to the invoice</a></p></>, 400);
  if (!(configuredEvmChains(c.env) as string[]).includes(chain)) return fail400("Choose a configured EVM chain.");
  if (mode !== "all" && mode !== "own" && mode !== "custom") return fail400("Choose which tokens to flush: all, own or custom.");
  if (mode === "own" && token !== "") return fail400("A token address only applies to the custom and all modes.");
  if (mode === "custom" && !isTokenAddress(token)) return fail400("A single-token recovery needs the token contract address: 0x followed by 40 hex digits.");
  if (mode === "all" && token !== "" && !isTokenAddress(token)) return fail400("The extra token must be a contract address: 0x followed by 40 hex digits.");
  if (token !== "" && /^0x0{40}$/i.test(token)) return fail400("The zero address is not a token.");
  const blocked = recoveryBlock(p, chain as EvmChain);
  if (blocked)
    return adminPage(c, { title: "Recover deposit", active: "invoices" }, <><Flash kind="error">{blocked.message}</Flash><p><a href={`/admin/invoices/${p.invoice_id}`}>Back to the invoice</a></p></>, blocked.code);
  let status: string;
  try {
    status = (await recoverDeposit(c.env, p, chain as EvmChain, Date.now(), token === "" ? undefined : (token as `0x${string}`), mode)).status;
  } catch (e) {
    console.warn(`0crypto: recovery on ${chain} failed: ${e instanceof Error ? e.name : "Error"}`);
    status = "failed";
  }
  return c.redirect(`/admin/invoices/${p.invoice_id}?recovery=${status}&chain=${chain}`, 303);
});

// Clears a payment's sweep back-off (sweep_error, sweep_retry_at) and its attempt count (sweep_paid_attempts: Tron's paid
// attempts, Solana's failed attempts), so the next cron run tries to sweep it again. Used after an operator looked at a
// Tron or Solana payment that stopped auto-retrying ("needs admin"). Needs passkey confirmation "sweep.retry".
admin.post("/payments/:id/retry-sweep", async (c) => {
  const p = await getPayment(c.env.DB, c.req.param("id"));
  if (!p) return notFound(c);
  const problem = await confirmProblem(c, await c.req.parseBody(), "sweep.retry");
  if (problem)
    return adminPage(c, { title: "Retry sweep", active: "invoices" }, <><Flash kind="error">{problem}</Flash><p><a href={`/admin/invoices/${p.invoice_id}`}>Back to the invoice</a></p></>, 403);
  const r = await c.env.DB.prepare(
    "UPDATE payments SET sweep_error=NULL, sweep_retry_at=NULL, sweep_paid_attempts=0, sweep_stale=0 WHERE id=? AND swept_at IS NULL AND sweep_error IS NOT NULL AND chain IN ('tron','sol')",
  )
    .bind(p.id)
    .run();
  if ((r.meta.changes ?? 0) === 0)
    return adminPage(c, { title: "Retry sweep", active: "invoices" }, <><Flash kind="error">Only a Tron or Solana payment whose sweep stopped with an error (and is not swept yet) can be retried.</Flash><p><a href={`/admin/invoices/${p.invoice_id}`}>Back to the invoice</a></p></>, 409);
  return c.redirect(`/admin/invoices/${p.invoice_id}`, 303);
});

admin.post("/events/:id/resend", async (c) => {
  const ev = await getEvent(c.env.DB, c.req.param("id"));
  if (!ev) return notFound(c);
  await enqueueEvents(c.env, [ev]);
  return c.redirect(`/admin/invoices/${ev.invoice_id}`, 303);
});

// ---------- More: every nav item as one list (the phone tab bar's fourth tab) ----------

admin.get("/more", (c) =>
  adminPage(
    c,
    { title: "More", active: "more" },
    <Panel label="All pages">
      {NAV_GROUPS.map((g) => (
        <div class="more-group">
          {g.label ? <p class="nav-group">{g.label}</p> : null}
          <ul class="more-list">
            {g.items.map((it) => (
              <li>
                <a href={it.href} class="more-item">
                  <Icon name={NAV_ICON[it.id]} />
                  <span>{it.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form method="post" action="/admin/logout" class="more-group">
        <Csrf token={c.get("csrf")} />
        <button type="submit" class="more-item more-button">
          <Icon name="out" />
          <span>Sign out</span>
        </button>
      </form>
    </Panel>,
  ),
);

// ---------- passkey confirmation, privacy routing and refunds (each money action needs a passkey confirmation) ----------

registerConfirm(admin);
registerRouting(admin);
registerRefunds(admin);
registerLinks(admin);
registerPos(admin);
registerSubs(admin);
registerPasskeys(admin);

// ---------- Settings and Developers (API keys, webhook; GET /admin/keys answers 301 to /admin/developers) ----------

registerSettings(admin);
registerDevelopers(admin);

// ---------- the first-run wizard (claim redirects to /admin/welcome) ----------

registerWelcome(admin);
