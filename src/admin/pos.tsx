import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { disablePin, getPosConfig, MAX_PIN_DIGITS, MIN_PIN_DIGITS, maxAgeOf, POS_COOKIE, setPin, mintPosCookie, validPin } from "../pos/store";
import { confirmProblem } from "./confirm";
import { secureCookie } from "./session";
import { adminPage, Csrf, PasskeyConfirm, type AdminEnv } from "./layout";
import { Flash, Panel } from "./ui";

/*
 * /admin/pos: POS settings. Setting, changing or disabling the PIN needs a passkey confirmation (403 otherwise), like the other
 * money-adjacent admin actions. The PIN is stored PBKDF2-hashed in D1 (pos_config) and every change bumps the version
 * embedded in POS cookies, so all POS sessions end. "Open POS" issues a POS cookie from the admin session (the admin
 * cookie is scoped to /admin and is not sent to /pos). Admin session and CSRF are enforced by the admin middleware.
 */

type Ctx = Context<AdminEnv>;
const formStr = (form: Record<string, unknown>, k: string): string => (typeof form[k] === "string" ? (form[k] as string) : "");

const PIN_PATTERN = `[0-9]{${MIN_PIN_DIGITS},${MAX_PIN_DIGITS}}`;

function PinField(props: { label: string; name: "pin" | "pin2" }) {
  const id = `f-${props.name}`;
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      <input class="input mono" id={id} name={props.name} type="password" inputmode="numeric" pattern={PIN_PATTERN} autocomplete="new-password" required />
    </div>
  );
}

function PosPage(props: { pinSet: boolean; csrf: string; notice?: string; error?: string }) {
  return (
    <>
      {props.notice ? <Flash kind="ok">{props.notice}</Flash> : null}
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      <Panel title={props.pinSet ? "Change PIN" : "Set a PIN"}>
        <p class="small muted">
          {props.pinSet ? "A PIN is set." : "No PIN is set: only an admin can open the POS."} Changing or disabling it signs out every POS session. {MIN_PIN_DIGITS} or more digits.
        </p>
        <form method="post" action="/admin/pos/pin" class="form" data-passkey-confirm="pos.pin">
          <Csrf token={props.csrf} />
          <PinField label="New PIN" name="pin" />
          <PinField label="Repeat PIN" name="pin2" />
          <PasskeyConfirm />
          <button type="submit" class="btn">{props.pinSet ? "Change PIN" : "Set PIN"}</button>
        </form>
      </Panel>
      {props.pinSet ? (
        <Panel title="Disable PIN">
          <p class="small muted">Removes the PIN and ends every POS session. Only an admin can then open the POS.</p>
          <form method="post" action="/admin/pos/disable" class="form" data-passkey-confirm="pos.disable">
            <Csrf token={props.csrf} />
            <PasskeyConfirm />
            <button type="submit" class="btn2">Disable PIN</button>
          </form>
        </Panel>
      ) : null}
      <Panel title="Lockout">
        <p class="small muted">
          Each address gets 5 PIN attempts per 15 minutes. Across all addresses, more than 200 attempts in an hour lock PIN login for everyone until the hour ends, and an alert appears on the overview. Trade-off: anyone who can reach the POS page can trigger that lock and stop staff signing in with the PIN. Devices that are already signed in keep working, and so does "Open the POS" above. A correct PIN gives its attempt back.
        </p>
      </Panel>
      <Panel title="How it works">
        <p class="small muted">
          The counter page at <a href="/pos">/pos</a> creates invoices for walk-in customers. Staff sign in there with a PIN; the admin can open it without one. "Open the POS" starts a session for 2 hours. It is not ended by signing out of the admin panel; changing or disabling the PIN ends it. There is no way to end a single session.
        </p>
      </Panel>
    </>
  );
}

export function registerPos(admin: Hono<AdminEnv>): void {
  const render = async (c: Ctx, extra: { notice?: string; error?: string } = {}, status: 200 | 400 | 403 = 200) =>
    adminPage(
      c,
      {
        title: "Point of sale",
        active: "pos",
        actions: (
          <form method="post" action="/admin/pos/open">
            <Csrf token={c.get("csrf")} />
            <button type="submit" class="btn">Open the POS</button>
          </form>
        ),
      }, <PosPage pinSet={(await getPosConfig(c.env.DB)).pin_hash !== null} csrf={c.get("csrf")} {...extra} />,
      status,
    );

  admin.get("/pos", (c) => render(c, { notice: { set: "PIN saved. All POS sessions were signed out.", off: "PIN disabled. All POS sessions were signed out." }[c.req.query("done") ?? ""] }));

  admin.post("/pos/pin", async (c) => {
    const form = await c.req.parseBody();
    const [pin, pin2] = [formStr(form, "pin"), formStr(form, "pin2")];
    // Format first, so a typo does not spend the passkey confirmation.
    if (!validPin(pin)) return render(c, { error: `The PIN must be ${MIN_PIN_DIGITS} to ${MAX_PIN_DIGITS} digits.` }, 400);
    if (pin !== pin2) return render(c, { error: "The PINs do not match." }, 400);
    const problem = await confirmProblem(c, form, "pos.pin");
    if (problem) return render(c, { error: problem }, 403);
    await setPin(c.env.DB, pin);
    return c.redirect("/admin/pos?done=set", 303);
  });

  admin.post("/pos/disable", async (c) => {
    const problem = await confirmProblem(c, await c.req.parseBody(), "pos.disable");
    if (problem) return render(c, { error: problem }, 403);
    await disablePin(c.env.DB);
    return c.redirect("/admin/pos?done=off", 303);
  });

  admin.post("/pos/open", async (c) => {
    const cfg = await getPosConfig(c.env.DB);
    const value = await mintPosCookie(c.env.SESSION_SECRET, "a", cfg.version, Date.now() + maxAgeOf("a") * 1000);
    setCookie(c, POS_COOKIE, value, { secure: secureCookie(c.req.url), sameSite: "Strict", path: "/pos", httpOnly: true, maxAge: maxAgeOf("a") });
    return c.redirect("/pos", 303);
  });
}
