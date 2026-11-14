import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

const CHALLENGE_URL = "/admin/webauthn/challenge";
const CANCELLED = "The passkey request was cancelled or timed out. Try again.";
const UNSUPPORTED = "This browser cannot use passkeys. Try a current Safari, Chrome, Edge or Firefox.";
const GENERIC = "Passkey request failed. Try again.";

class ServerError extends Error {}

function showError(form: HTMLFormElement, msg: string): void {
  const el = form.querySelector<HTMLElement>("[data-passkey-error]");
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
}

function isCancel(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | null;
  return err?.name === "NotAllowedError" || err?.name === "AbortError" || err?.code === "ERROR_CEREMONY_ABORTED";
}

function describe(e: unknown): string {
  if (e instanceof ServerError) return e.message;
  if (isCancel(e)) return CANCELLED;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m : GENERIC;
}

function field(form: HTMLFormElement, name: string): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
}

function setField(form: HTMLFormElement, name: string, value: string): void {
  const el = field(form, name);
  if (!el) throw new Error(`missing ${name} field`);
  el.value = value;
}

// String-valued form entries, minus the named ones.
function entries(form: HTMLFormElement, skip: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of new FormData(form)) if (typeof v === "string" && !skip.includes(k)) out.push([k, v]);
  return out;
}

async function postForOptions<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  let data: { options?: T; error?: string } | null = null;
  try {
    data = (await res.json()) as { options?: T; error?: string };
  } catch {
    /* non-JSON answer */
  }
  if (data?.error) throw new ServerError(data.error);
  if (!res.ok || !data?.options) throw new ServerError(GENERIC);
  return data.options;
}

async function confirmStep(form: HTMLFormElement, action: string): Promise<void> {
  const params: Record<string, string> = {};
  for (const [k, v] of entries(form, ["csrf", "assertion", "credential"])) params[k] = v;
  params._path = new URL(form.action, location.href).pathname;
  const body = new URLSearchParams({ csrf: field(form, "csrf")?.value ?? "", action, params: JSON.stringify(params) });
  const options = await postForOptions<PublicKeyCredentialRequestOptionsJSON>(CHALLENGE_URL, body);
  const assertion = await startAuthentication({ optionsJSON: options });
  setField(form, "assertion", JSON.stringify(assertion));
}

async function registerStep(form: HTMLFormElement, optionsUrl: string): Promise<void> {
  const body = new URLSearchParams(entries(form, ["credential", "assertion"]));
  const options = await postForOptions<PublicKeyCredentialCreationOptionsJSON>(optionsUrl, body);
  const credential = await startRegistration({ optionsJSON: options });
  setField(form, "credential", JSON.stringify(credential));
}

async function loginStep(form: HTMLFormElement, optionsUrl: string): Promise<void> {
  const body = new URLSearchParams(entries(form, ["assertion", "credential"]));
  const options = await postForOptions<PublicKeyCredentialRequestOptionsJSON>(optionsUrl, body);
  const assertion = await startAuthentication({ optionsJSON: options });
  setField(form, "assertion", JSON.stringify(assertion));
}

function wire(form: HTMLFormElement): void {
  const confirm = form.dataset.passkeyConfirm;
  const register = form.dataset.passkeyRegister;
  const login = form.dataset.passkeyLogin;
  if (confirm === undefined && register === undefined && login === undefined) return;
  let busy = false;

  form.addEventListener("submit", (ev) => {
    // A filled-in credential/assertion means this is the final, scripted submit.
    if (confirm !== undefined && !field(form, "assertion")?.value) {
      /* needs the ceremony */
    } else if (login !== undefined && !field(form, "assertion")?.value) {
      /* needs the ceremony */
    } else if (register !== undefined && !field(form, "credential")?.value) {
      /* needs the ceremony */
    } else return;
    ev.preventDefault();
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        if (!browserSupportsWebAuthn()) throw new ServerError(UNSUPPORTED);
        if (confirm !== undefined && !field(form, "assertion")?.value) await confirmStep(form, confirm);
        if (login !== undefined && !field(form, "assertion")?.value) await loginStep(form, login);
        if (register !== undefined && !field(form, "credential")?.value) await registerStep(form, register);
        form.submit();
      } catch (e) {
        showError(form, describe(e));
        busy = false;
      }
    })();
  });

  // Conditional UI: a passkey picked from the browser's autofill dropdown signs in without a click.
  const loginUrl = login;
  if (loginUrl !== undefined && form.querySelector('input[autocomplete~="webauthn"]')) {
    void (async () => {
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        const body = new URLSearchParams(entries(form, ["assertion", "credential"]));
        const options = await postForOptions<PublicKeyCredentialRequestOptionsJSON>(loginUrl, body);
        const assertion = await startAuthentication({ optionsJSON: options, useBrowserAutofill: true });
        setField(form, "assertion", JSON.stringify(assertion));
        busy = true;
        form.submit();
      } catch (e) {
        // Autofill is opportunistic: a replaced or dismissed ceremony is not an error worth showing.
        if (!isCancel(e)) showError(form, describe(e));
      }
    })();
  }
}

function init(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>("form[data-passkey-confirm], form[data-passkey-register], form[data-passkey-login]")) wire(form);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
