import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { createOrReusePayment, lightningUnavailable } from "../api/invoices";
import type { ApiErrorCode } from "../api/errors";
import { usableAssets } from "../config";
import { formatDecimal, formatFiat } from "../core/money";
import { getAsset } from "../core/assets";
import type { AssetInfo, ChainId } from "../core/types";
import { getInvoice, getPayment, listPayments, type InvoiceRow, type PaymentRow, type PaymentStatus } from "../db/repo";
import type { Env } from "../env";
import { getAdapter } from "../chains/registry";
import { isEvmChain } from "../chains/evm/config";
import { PriceUnavailable } from "../prices/cache";
import { toTarget } from "../watcher/PaymentWatcher";
import { Layout, MerchantBar, merchantName, page } from "./layout";
import { qrSvg } from "./qr";

const CHAIN_NAME: Partial<Record<ChainId, string>> = {
  btc: "Bitcoin",
  ltc: "Litecoin",
  doge: "Dogecoin",
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  polygon: "Polygon",
  bsc: "BNB Chain",
  tron: "Tron",
  sol: "Solana",
  ln: "Lightning",
};
const CONFIRM_TIME: Partial<Record<ChainId, string>> = {
  btc: "About 20 minutes",
  ltc: "About 15 minutes",
  doge: "About 20 minutes",
  // EVM: the `finalized` tag (Ethereum ~13 min; L2s wait for L1; Polygon and BNB Chain finalize in about a minute).
  eth: "About 15 minutes",
  base: "About 20 minutes",
  arb: "About 20 minutes",
  polygon: "About 1 minute",
  bsc: "About 1 minute",
  tron: "About 1 minute",
  sol: "About 1 minute",
  ln: "Usually seconds",
};
const chainLabel = (c: ChainId) => CHAIN_NAME[c] ?? c.toUpperCase();
export { CONFIRM_TIME };

/** The "only send X on Y" wrapper warning shown under the address. */
export function networkWarning(asset: { chain: ChainId; symbol: string }): string {
  const chainName = chainLabel(asset.chain);
  if (asset.chain === "ln") return "Only pay this invoice from a Lightning wallet. It is for this exact amount and can be paid once.";
  if (asset.chain === "tron") return `Only send ${asset.symbol} on ${chainName} (TRC-20). Other networks can't be credited automatically.`;
  if (asset.chain === "sol") return `Only send ${asset.symbol} on ${chainName}. Other networks can't be credited automatically.`;
  if (isEvmChain(asset.chain)) return `Only send ${asset.symbol} on ${chainName}. Other networks can't be credited automatically.`;
  return `Only send ${asset.symbol} on the ${chainName} network. Other coins or networks can't be credited automatically.`;
}
const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€" };

const STATUS_TEXT: Record<PaymentStatus | "paid", string> = {
  awaiting: "Waiting for payment",
  detected: "Payment detected, waiting for confirmation",
  confirming: "Confirming on the network",
  confirmed: "Payment confirmed",
  partial: "Partial payment received",
  expired: "Payment window expired",
  paid: "Paid",
};

const money = (inv: InvoiceRow, minor: bigint) => `${CURRENCY_SYMBOL[inv.currency] ?? ""}${formatFiat(minor)}`;
const isExpired = (inv: InvoiceRow, now: number) => inv.status !== "paid" && (inv.status === "expired" || now > inv.expires_at);
const remaining = (inv: InvoiceRow) => (inv.price_minor > inv.paid_minor ? inv.price_minor - inv.paid_minor : 0n);

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Shell(props: { env: Env; inv: InvoiceRow; title: string; head?: Child; scripts?: string[]; children?: Child }) {
  const name = merchantName(props.env);
  return (
    <Layout title={`${props.title} · ${name}`} css={["/checkout.css"]} scripts={props.scripts} head={props.head}>
      <div class="page">
        <MerchantBar name={name} orderId={props.inv.order_id} />
        <main class="card checkout-card">{props.children}</main>
        <div class="foot muted small">
          <span>No account, no tracking</span>
        </div>
      </div>
    </Layout>
  );
}

function Amount(props: { label: string; value: string }) {
  return (
    <div class="amount-block">
      <span class="muted small">{props.label}</span>
      <span class="amount">{props.value}</span>
    </div>
  );
}

function PaidBlock(props: { inv: InvoiceRow }) {
  const { inv } = props;
  return (
    <>
      <div class="notice notice-ok">Payment received. Thank you.</div>
      {inv.success_url ? (
        <a class="btn btn-link" href={inv.success_url}>
          Return to store
        </a>
      ) : null}
    </>
  );
}

function Notice(props: { title: string; body: Child; back?: string; backLabel?: string }) {
  return (
    <>
      <div class="amount-block">
        <span class="headline">{props.title}</span>
      </div>
      <p class="muted">{props.body}</p>
      {props.back ? (
        <a class="btn2 btn-link" href={props.back}>
          {props.backLabel ?? "Back"}
        </a>
      ) : null}
    </>
  );
}

function ChoicePage(props: { env: Env; inv: InvoiceRow; assets: AssetInfo[]; now: number }) {
  const { env, inv, assets, now } = props;
  if (inv.status === "paid")
    return (
      <Shell env={env} inv={inv} title="Paid" head={inv.success_url ? <meta http-equiv="refresh" content={`3;url=${inv.success_url}`} /> : null}>
        <Amount label="Amount paid" value={money(inv, inv.price_minor)} />
        <PaidBlock inv={inv} />
      </Shell>
    );
  if (isExpired(inv, now))
    return (
      <Shell env={env} inv={inv} title="Invoice expired">
        <Notice title="This invoice has expired" body="Payment is no longer possible for this invoice. Return to the store to start a new one." />
      </Shell>
    );
  return (
    <Shell env={env} inv={inv} title="Choose how to pay">
      <Amount label="Amount due" value={money(inv, remaining(inv))} />
      <div class="muted small">Pay with</div>
      <div class="choices">
        {assets.map((a) => (
          <form method="post" action={`/i/${inv.id}/pay`}>
            <input type="hidden" name="asset" value={a.id} />
            <button type="submit" class="btn2 choice">
              <span class="mono">{a.symbol}</span>
              <span class="muted small">{chainLabel(a.chain)}</span>
            </button>
          </form>
        ))}
      </div>
    </Shell>
  );
}

function PaymentPage(props: { env: Env; inv: InvoiceRow; p: PaymentRow; now: number }) {
  const { env, inv, p, now } = props;
  const asset = getAsset(p.asset);
  const adapter = getAdapter(env, asset.chain);
  const paid = inv.status === "paid";
  const open = !paid && !isExpired(inv, now);
  // Funds already seen: ask only for what is still outstanding.
  const partlyIn = !paid && p.received > 0n && p.status !== "confirmed";
  const outstanding = partlyIn ? p.expected - p.received : p.expected;
  // Fully received, or within tolerance and confirming: wait on confirmations, never ask for dust.
  const settling = partlyIn && (outstanding <= 0n || p.status === "confirming");
  const amount = formatDecimal(outstanding > 0n ? outstanding : 0n, asset.decimals);
  const uri = adapter.paymentUri(toTarget(p), asset, outstanding > 0n ? outstanding : p.expected);
  const confirmedUnpaid = !paid && p.status === "confirmed"; // credited, but the invoice still has a balance (e.g. re-priced)
  const stillDue = remaining(inv);
  const deadInvoice = !paid && !open && p.status === "awaiting" && p.received === 0n; // expired, nothing in flight
  const lockEnded = open && p.status === "awaiting" && p.received === 0n;
  const lockPassed = p.rate_locked_until <= now;
  // Lightning: the address is a fixed-amount bolt11 that expires with the lock. Once it has, it cannot be paid: no QR,
  // and a plain form (works without JS) asks the wallet for a fresh invoice through the usual payment endpoint.
  const ln = asset.chain === "ln";
  const lnExpired = ln && lockEnded && lockPassed;
  const statusKey = paid ? "paid" : p.status;
  const chainName = chainLabel(asset.chain);
  const wsPath = `/i/${inv.id}/p/${p.id}/ws`;
  const head = (
    <>
      {paid && inv.success_url ? <meta http-equiv="refresh" content={`3;url=${inv.success_url}`} /> : null}
      {!paid ? (
        <noscript>
          <meta http-equiv="refresh" content="20" />
        </noscript>
      ) : null}
    </>
  );
  return (
    <Shell env={env} inv={inv} title={paid ? "Paid" : `Pay ${asset.symbol}`} head={head} scripts={["/checkout.js"]}>
      {/* checkout.js reloads when a live status or received amount differs from what was rendered. */}
      <div
        data-ws={wsPath}
        data-paid={paid ? "1" : "0"}
        data-status={p.status}
        data-received={formatDecimal(p.received, asset.decimals)}
        class="stack"
      >
        <Amount label={paid ? "Amount paid" : "Amount due"} value={money(inv, paid ? inv.price_minor : remaining(inv))} />

        {paid ? <PaidBlock inv={inv} /> : null}

        <div class="pair">
          <div class="well pick">
            <span class="muted tiny">Coin</span>
            <span>{asset.symbol}</span>
          </div>
          <div class="well pick">
            <span class="muted tiny">Network</span>
            <span>{chainName}</span>
          </div>
        </div>
        {open ? (
          <a class="change small" href={`/i/${inv.id}`}>
            change
          </a>
        ) : null}

        {deadInvoice ? <div class="notice notice-warn">This invoice has expired</div> : null}
        {lockEnded && ln ? (
          <div class="notice notice-warn stack" data-lock-notice hidden={!lockPassed}>
            <span>This Lightning invoice has expired. Don't pay it.</span>
            <form method="post" action={`/i/${inv.id}/pay`}>
              <input type="hidden" name="asset" value={asset.id} />
              <button type="submit" class="btn action">
                New invoice
              </button>
            </form>
          </div>
        ) : lockEnded ? (
          <div class="notice notice-warn" data-lock-notice hidden={!lockPassed}>
            The price lock has ended. <a href={`/i/${inv.id}`}>Pick the coin again for a fresh quote</a>
          </div>
        ) : null}
        {settling ? <div class="notice notice-ok">Payment received, waiting for confirmations</div> : null}
        {confirmedUnpaid ? (
          <>
            <div class="notice notice-ok">Payment confirmed</div>
            {open && stillDue > 0n ? (
              <div class="notice notice-warn">
                {money(inv, stillDue)} still due on this invoice. <a href={`/i/${inv.id}`}>Pay the rest</a>
              </div>
            ) : null}
          </>
        ) : null}

        {!paid && !settling && !confirmedUnpaid && !lnExpired ? (
          <>
            <div class="pay-row">
              {/* BOLT11 QR codes are uppercased: the alphanumeric mode makes them much less dense. A Lightning QR is hidden
                  by checkout.js when the countdown ends (data-hide-on-lock): the expired bolt11 can no longer be paid. */}
              {deadInvoice ? null : (
                <div class="qr-box" data-hide-on-lock={ln ? "" : undefined} dangerouslySetInnerHTML={{ __html: qrSvg(ln ? uri.toUpperCase() : uri) }}></div>
              )}
              <div class="pay-text">
                {partlyIn ? (
                  <div class="field">
                    <span class="muted tiny">Received</span>
                    <span class="mono">
                      {formatDecimal(p.received, asset.decimals)} {asset.symbol}
                    </span>
                  </div>
                ) : null}
                {deadInvoice ? null : (
                  <div class="field">
                    <span class="muted tiny">{ln ? "Amount" : partlyIn ? "Send the remaining" : "Send exactly"}</span>
                    <span class="mono amt" data-select-amount>
                      {amount} {asset.symbol}
                    </span>
                  </div>
                )}
                <div class="field">
                  <span class="muted tiny">
                    {ln ? (deadInvoice ? "Don't pay this invoice" : "Lightning invoice") : deadInvoice ? "Don't send funds to this address" : "To this address"}
                  </span>
                  <span class="mono addr" data-select-addr>
                    {p.address.slice(0, -4)}
                    <b>{p.address.slice(-4)}</b>
                  </span>
                </div>
              </div>
            </div>

            <div class="pair" data-hide-on-lock={ln ? "" : undefined}>
              <button type="button" class="btn action" data-copy={p.address} data-select="[data-select-addr]">
                {ln ? "Copy invoice" : "Copy address"}
              </button>
              {deadInvoice || ln ? null : (
                <button type="button" class="btn2 action" data-copy={amount} data-select="[data-select-amount]">
                  Copy amount
                </button>
              )}
            </div>

            {deadInvoice ? null : (
              <div class="warn">
                {networkWarning(asset)}
              </div>
            )}
          </>
        ) : null}

        <div class="rows">
          {!paid ? (
            <div class="row">
              <span class="muted">{ln ? "Invoice expires in" : "Rate locked for"}</span>
              <span class="mono" data-countdown={String(p.rate_locked_until)}>
                {mmss(p.rate_locked_until - now)}
              </span>
            </div>
          ) : null}
          <div class="row">
            <span class="muted">Confirmation</span>
            <span>{CONFIRM_TIME[asset.chain] ?? "A few minutes"}</span>
          </div>
          <div class="row">
            <span class="muted">Status</span>
            <span class="status">
              <span class="dot" data-s={statusKey}></span>
              <span>{STATUS_TEXT[statusKey]}</span>
            </span>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function PaymentError(props: { env: Env; inv: InvoiceRow; title: string; body: Child; link?: { href: string; label: string } }) {
  return (
    <Shell env={props.env} inv={props.inv} title={props.title}>
      <Notice title={props.title} body={props.body} back={props.link?.href} backLabel={props.link?.label} />
    </Shell>
  );
}

export const checkout = new Hono<{ Bindings: Env }>();

checkout.get("/i/:id", async (c) => {
  const inv = await getInvoice(c.env.DB, c.req.param("id"));
  if (!inv) return notFound(c);
  const assets = (await usableAssets(c.env)).filter((a) => !inv.allowed_assets || inv.allowed_assets.includes(a.id));
  return page(c, <ChoicePage env={c.env} inv={inv} assets={assets} now={Date.now()} />);
});

checkout.get("/i/:id/p/:pid", async (c) => {
  const [inv, p] = await Promise.all([getInvoice(c.env.DB, c.req.param("id")), getPayment(c.env.DB, c.req.param("pid"))]);
  if (!inv || !p || p.invoice_id !== inv.id) return notFound(c);
  return page(c, <PaymentPage env={c.env} inv={inv} p={p} now={Date.now()} />);
});

checkout.post("/i/:id/pay", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env.DB, id);
  if (!inv) return notFound(c);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const asset = typeof form.asset === "string" ? form.asset : "";
  const fail = (title: string, body: string, status: 400 | 409 | 429 | 503, link?: { href: string; label: string }) =>
    page(c, <PaymentError env={c.env} inv={inv} title={title} body={body} link={link} />, status);

  let r;
  try {
    // The IP is only a rate-limit key; it is never stored or logged.
    r = await createOrReusePayment(c.env, id, asset, c.req.header("cf-connecting-ip") ?? "unknown");
  } catch (e) {
    if (e instanceof PriceUnavailable) return fail("Price unavailable", "Try again in a minute.", 503, { href: `/i/${id}`, label: "Try again" });
    if (lightningUnavailable(e))
      return fail("Lightning is unavailable", "The Lightning wallet did not answer. Try again in a minute, or choose another way to pay.", 503, { href: `/i/${id}`, label: "Try again" });
    throw e;
  }
  if (!("error" in r)) return c.redirect(`/i/${id}/p/${r.body.payment_id}`, 303);

  const code: ApiErrorCode = r.error.code;
  switch (code) {
    case "invoice_closed": {
      const fresh = (await getInvoice(c.env.DB, id)) ?? inv;
      return fresh.status === "paid" || fresh.paid_minor >= fresh.price_minor
        ? fail("This invoice is already paid", "Nothing more is due.", 409)
        : fail("This invoice has expired", "Payment is no longer possible for this invoice.", 409);
    }
    case "payment_in_progress": {
      const flying = (await listPayments(c.env.DB, id)).find((p) => p.status === "detected" || p.status === "confirming" || p.status === "partial");
      return flying
        ? fail("A payment is already in progress", "Your payment is awaiting confirmation.", 409, { href: `/i/${id}/p/${flying.id}`, label: "View payment" })
        : fail("A payment is already in progress", "Your payment is awaiting confirmation.", 409);
    }
    case "rate_limited":
      return fail("Too many requests", "Please wait a moment and try again.", 429, { href: `/i/${id}`, label: "Back" });
    case "not_found":
      return notFound(c);
    default:
      return fail("That option isn't available", "Please choose another way to pay.", 400, { href: `/i/${id}`, label: "Back" });
  }
});

checkout.get("/i/:id/p/:pid/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("expected websocket upgrade", 426, { Upgrade: "websocket" });
  const id = c.req.param("id");
  const pid = c.req.param("pid");
  const p = await getPayment(c.env.DB, pid);
  if (!p || p.invoice_id !== id) return c.text("not found", 404);
  const stub = c.env.WATCHER.get(c.env.WATCHER.idFromName(id));
  return stub.fetch(new Request(new URL(c.req.url).origin + "/ws?payment=" + encodeURIComponent(pid), c.req.raw));
});

function notFound(c: Context<{ Bindings: Env }>) {
  const inv = { order_id: null } as InvoiceRow;
  return page(
    c,
    <Shell env={c.env} inv={inv} title="Not found">
      <Notice title="Page not found" body="This payment link is not valid." />
    </Shell>,
    404,
  );
}
