// Helpers for the claim, sign-in and recovery flow tests (test/admin/claim, login and recover): requests through the
// Worker's own fetch (effectiveEnv included) with per-call env overrides, the pre-auth cookie + CSRF token a page hands
// out, and the one-time codes read back from the log lines (the only place a code is ever written).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { sha256Hex } from "../src/api/auth";
import { SETUP_COOKIE, cookieName } from "../src/admin/session";
import { newSetupCode, type CodePurpose } from "../src/admin/setup-codes";
import type { Env } from "../src/env";
import worker from "../src/index";

export const e = env as unknown as Env;

let ipSeq = 0;
/** A client address no other request used, so the per-client code limits never interfere between tests. */
export const freshIp = (): string => `10.${70 + ((ipSeq >> 16) & 15)}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

export type CallOpts = { form?: Record<string, string>; cookie?: string; ip?: string; env?: Partial<Env> };

/** GET (no form) or POST (form) `url` through the Worker's fetch with `env` overrides; redirects are not followed. */
export async function call(url: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp() };
  if (o.cookie) headers.cookie = o.cookie;
  let init: RequestInit = { headers, redirect: "manual" };
  if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    init = { ...init, method: "POST", body: new URLSearchParams(o.form) };
  }
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(url, init), { ...e, ...o.env } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

/** `name=value` of a Set-Cookie on `r`, if set. */
export const setCookieOf = (r: Response, name: string): string | undefined => r.headers.getSetCookie().find((c) => c.startsWith(name + "="));
export const cookiePair = (raw: string | undefined): string | undefined => raw?.split(";")[0];
export const csrfIn = (html: string): string => /name="csrf" value="([^"]+)"/.exec(html)![1]!;

/** A page's pre-auth state: the `__Host-0c_setup` cookie it set (or the one sent) and the CSRF token in its form. */
export async function preAuthPage(url: string, o: CallOpts = {}): Promise<{ r: Response; html: string; cookie: string; csrf: string }> {
  const r = await call(url, o);
  const html = await r.text();
  const name = cookieName(SETUP_COOKIE, url);
  const cookie = cookiePair(setCookieOf(r, name)) ?? o.cookie ?? "";
  return { r, html, cookie, csrf: csrfIn(html) };
}

const LINE = /^0crypto (setup|recovery) code: ((?:[a-z]+ ){5}[a-z]+) \(valid 60 min\)$/;

/** Spies on console.log; `codes()` are the phrases printed since, in order. */
export function logSpy() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const lines = () => spy.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
  return {
    spy,
    lines,
    codes: (purpose?: CodePurpose) =>
      lines().flatMap((l) => {
        const m = LINE.exec(l);
        if (!m) return [];
        if (purpose && m[1] !== (purpose === "setup" ? "setup" : "recovery")) return [];
        return [m[2]!];
      }),
  };
}

/**
 * Puts a live code of `purpose` straight into setup_codes (printCode prints at most one per 120 s) and returns it.
 * Dated 130 s ago, so it does not hold back the next printCode.
 */
export async function liveCode(purpose: CodePurpose): Promise<string> {
  const code = newSetupCode();
  const now = Date.now();
  await e.DB.prepare("INSERT INTO setup_codes(hash,purpose,created_at,expires_at) VALUES(?,?,?,?)").bind(await sha256Hex(code), purpose, now - 130_000, now + 3_000_000).run();
  return code;
}

/** POSTs a passkey options request and returns the parsed JSON with the status. */
export async function options<T = unknown>(url: string, o: CallOpts): Promise<{ status: number; body: { options?: T; error?: string } }> {
  const r = await call(url, o);
  return { status: r.status, body: (await r.json()) as { options?: T; error?: string } };
}
