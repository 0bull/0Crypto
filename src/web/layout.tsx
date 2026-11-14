import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Env } from "../env";

/** Every HTML page carries exactly this CSP: no inline script or style, nothing third-party. */
export const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function merchantName(env: Pick<Env, "MERCHANT_NAME">): string {
  return env.MERCHANT_NAME?.trim() || "Store";
}

export function Layout(props: { title: string; head?: Child; css?: string[]; scripts?: string[]; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/theme.css" />
        {(props.css ?? []).map((href) => (
          <link rel="stylesheet" href={href} />
        ))}
        {props.head}
      </head>
      <body>
        {props.children}
        {(props.scripts ?? []).map((src) => (
          <script src={src} defer></script>
        ))}
      </body>
    </html>
  );
}

/** Merchant badge (initial in a square) on the left, optional order reference on the right. */
export function MerchantBar(props: { name: string; orderId?: string | null }) {
  return (
    <div class="merchant-bar">
      <div class="merchant">
        <div class="badge">{Array.from(props.name)[0]?.toUpperCase() ?? "S"}</div>
        <span class="merchant-name">{props.name}</span>
      </div>
      {props.orderId ? <span class="muted small order" title={`Order #${props.orderId}`}>
          Order #{props.orderId}
        </span> : null}
    </div>
  );
}

/** Renders a page with the security headers every response needs. */
export function page(c: Context, node: Child, status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503 = 200): Response {
  c.header("content-security-policy", CSP);
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("cache-control", "no-store");
  return c.html("<!DOCTYPE html>" + String(node), status);
}

/** The app-level error page: generic text only, never the error's message. */
export function errorPage(c: Context<{ Bindings: Env }>): Response {
  const name = merchantName(c.env ?? {});
  return page(
    c,
    <Layout title={`Error · ${name}`} css={["/checkout.css"]}>
      <div class="page">
        <MerchantBar name={name} />
        <section class="card pad">
          <h1>Something went wrong</h1>
          <p class="muted">Please try again in a minute. If it keeps happening, contact the merchant.</p>
        </section>
      </div>
    </Layout>,
    500,
  );
}
