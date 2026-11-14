import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Env } from "../env";
import { Layout, merchantName, page } from "../web/layout";
import { Icon, type IconName } from "./ui";

export { PasskeyConfirm, PasskeyConfirmNote } from "./ui";

/** `session` is the valid session cookie value, or null before sign-in (only public paths get that far). */
export type AdminEnv = { Bindings: Env; Variables: { csrf: string; session: string | null } };

export type NavId = "overview" | "invoices" | "links" | "pos" | "subs" | "wallets" | "privacy" | "developers" | "passkeys" | "settings";
/** What the shell marks as the current page: a nav item, or the phone's More page. */
export type ShellActive = NavId | "more";

/** The sidebar, by job. Items marked `tab` are also in the phone's bottom tab bar (with More). */
export const NAV_GROUPS: { label: string | null; items: { id: NavId; href: string; label: string; tab?: true }[] }[] = [
  { label: null, items: [{ id: "overview", href: "/admin", label: "Overview", tab: true }] },
  {
    label: "Get paid",
    items: [
      { id: "invoices", href: "/admin/invoices", label: "Invoices", tab: true },
      { id: "links", href: "/admin/links", label: "Payment links" },
      { id: "pos", href: "/admin/pos", label: "Point of sale", tab: true },
      { id: "subs", href: "/admin/subscriptions", label: "Subscriptions" },
    ],
  },
  {
    label: "Your money",
    items: [
      { id: "wallets", href: "/admin/wallets", label: "Wallets" },
      { id: "privacy", href: "/admin/privacy", label: "Privacy routing" },
    ],
  },
  { label: "Developers", items: [{ id: "developers", href: "/admin/developers", label: "API keys & webhooks" }] },
  {
    label: "Account",
    items: [
      { id: "passkeys", href: "/admin/passkeys", label: "Passkeys" },
      { id: "settings", href: "/admin/settings", label: "Settings" },
    ],
  },
];

export const NAV_ICON: Record<NavId, IconName> = {
  overview: "home",
  invoices: "invoice",
  links: "link",
  pos: "pos",
  subs: "repeat",
  wallets: "wallet",
  privacy: "shield",
  developers: "code",
  passkeys: "key",
  settings: "gear",
};
/** The shorter words the phone tab bar uses. */
const TAB_LABEL: Partial<Record<NavId, string>> = { overview: "Home", pos: "POS" };
const TAB_IDS = new Set<ShellActive>(NAV_GROUPS.flatMap((g) => g.items.filter((i) => i.tab).map((i) => i.id)));

export function Csrf(props: { token: string }) {
  return <input type="hidden" name="csrf" value={props.token} />;
}

const PASSKEY_JS = "/admin-passkey.js";
/** Every admin page loads the passkey script last, after /admin.js (it handles data-passkey-* forms). */
const withPasskeyScript = (scripts: string[] | undefined): string[] => [...(scripts ?? []).filter((s) => s !== PASSKEY_JS), PASSKEY_JS];

/** The red "0" glyph and the wordmark. */
function Logo(props: { class?: string; href?: string }) {
  const inner = (
    <>
      <span class="logo-mark" aria-hidden="true">
        0
      </span>
      <span class="logo-word">0Crypto</span>
    </>
  );
  const cls = props.class ? `logo ${props.class}` : "logo";
  return props.href ? (
    <a href={props.href} class={cls}>
      {inner}
    </a>
  ) : (
    <div class={cls}>{inner}</div>
  );
}

function NavLink(props: { href: string; icon: IconName; on: boolean; current: boolean; label: string; tabLabel?: string; class?: string }) {
  return (
    <li class={props.class}>
      <a href={props.href} class={props.on ? "nav-item is-on" : "nav-item"} aria-current={props.current ? "page" : undefined}>
        <Icon name={props.icon} />
        {props.tabLabel ? (
          <>
            <span class="side-only">{props.label}</span>
            <span class="tab-only">{props.tabLabel}</span>
          </>
        ) : (
          <span>{props.label}</span>
        )}
      </a>
    </li>
  );
}

/**
 * The signed-in shell. One `<nav aria-label="Main">`: the grouped sidebar on wide screens, the bottom tab bar on phones
 * (Home, Invoices, POS, More; a page outside those lights More). The header shows the shop name, the page's one <h1>
 * and its primary action. Everything is links and plain forms, so it works without JavaScript.
 */
export function AdminShell(props: { title: string; active: ShellActive; csrf: string; shopName: string; actions?: Child; scripts?: string[]; children?: Child }) {
  const moreOn = !TAB_IDS.has(props.active);
  return (
    <Layout title={`${props.title} · 0Crypto`} css={["/admin.css"]} scripts={withPasskeyScript(props.scripts)}>
      <a href="#main" class="skip">
        Skip to content
      </a>
      <div class="shell">
        <nav class="side" aria-label="Main">
          <Logo class="side-only" />
          {NAV_GROUPS.map((g, gi) => (
            <div class="nav-sec">
              {g.label ? (
                <p class="nav-group side-only" id={`nav-g${gi}`}>
                  {g.label}
                </p>
              ) : null}
              <ul class="nav-list" aria-labelledby={g.label ? `nav-g${gi}` : undefined}>
                {g.items.map((it) => (
                  <NavLink
                    href={it.href}
                    icon={NAV_ICON[it.id]}
                    on={it.id === props.active}
                    current={it.id === props.active}
                    label={it.label}
                    tabLabel={TAB_LABEL[it.id]}
                    class={it.tab ? undefined : "side-only"}
                  />
                ))}
              </ul>
            </div>
          ))}
          <ul class="nav-list nav-more">
            <NavLink href="/admin/more" icon="more" on={moreOn} current={props.active === "more"} label="More" class="tab-only" />
          </ul>
          <form method="post" action="/admin/logout" class="logout side-only">
            <Csrf token={props.csrf} />
            <button type="submit" class="nav-item nav-button">
              <Icon name="out" />
              <span>Sign out</span>
            </button>
          </form>
        </nav>
        <main class="main" id="main">
          <header class="page-head">
            <Logo class="tab-only" href="/admin" />
            <div class="page-title">
              <p class="shop">{props.shopName}</p>
              <h1>{props.title}</h1>
            </div>
            {props.actions !== undefined && props.actions !== null ? <div class="page-actions">{props.actions}</div> : null}
          </header>
          {props.children}
        </main>
      </div>
    </Layout>
  );
}

/**
 * Renders a signed-in page in the shell, with the CSRF token and shop name from the request (the effective env, so a
 * shop name saved in Settings shows at once). The body must not have its own <h1>: the shell's header has it.
 */
export function adminPage(
  c: Context<AdminEnv>,
  shell: { title: string; active: ShellActive; actions?: Child; scripts?: string[] },
  body: Child,
  status: 200 | 400 | 403 | 404 | 409 | 429 = 200,
): Response {
  return page(
    c,
    <AdminShell title={shell.title} active={shell.active} csrf={c.get("csrf")} shopName={merchantName(c.env)} actions={shell.actions} scripts={shell.scripts}>
      {body}
    </AdminShell>,
    status,
  );
}

/**
 * The 440px panel for setup, sign-in, recovery, the wizard and the error pages (no sidebar), the wordmark above it.
 * `step` shows "Step n of m · label" and an m-segment progress list (the current item has aria-current="step").
 */
export function AuthShell(props: { title: string; step?: { n: number; of: number; label: string; labels?: string[] }; scripts?: string[]; children?: Child }) {
  const step = props.step;
  return (
    <Layout title={`${props.title} · 0Crypto`} css={["/admin.css"]} scripts={withPasskeyScript(props.scripts)}>
      <main class="auth" id="main">
        <Logo />
        {step ? (
          <div class="auth-progress">
            <p class="auth-step">
              Step {step.n} of {step.of} · {step.label}
            </p>
            <ol class="steps" aria-label="Setup steps">
              {Array.from({ length: step.of }, (_, i) => (
                <li aria-current={i + 1 === step.n ? "step" : undefined} class={i + 1 <= step.n ? "is-done" : undefined}>
                  <span class="sr">{step.labels?.[i] ?? `Step ${i + 1}`}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <div class="panel auth-card">{props.children}</div>
      </main>
    </Layout>
  );
}

/** The 404 page for a record or path that is not there (also what a closed setup path answers). */
export function NotFoundPage() {
  return (
    <AuthShell title="Not found">
      <h1 class="auth-title">Not found</h1>
      <p class="muted">That page or record does not exist. Check the address, or go back to the dashboard.</p>
      <p class="auth-links small">
        <a href="/admin">Back to the dashboard</a>
      </p>
    </AuthShell>
  );
}
