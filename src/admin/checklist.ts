import { usableAssets } from "../config";
import type { Env } from "../env";
import { currentRpId } from "./rp";

/*
 * The Overview's "Finish setting up" checklist (Plan 7's done conditions; the one source for them). Every open item
 * links to the place that does it: the first-run wizard's steps for the wallet, the first payment and the webhook,
 * the Passkeys page for passkeys.
 */

export type SetupChecklist = { passkey: boolean; wallet: boolean; paidInvoice: boolean; webhook: boolean; backupPasskey: boolean };

export async function setupChecklist(env: Env): Promise<SetupChecklist> {
  const [row, wallet] = await Promise.all([
    // A backup counts only when it works here: a passkey for PUBLIC_URL's host, not one left from an old domain.
    env.DB.prepare("SELECT (SELECT count(*) FROM passkeys) AS passkeys, (SELECT count(*) FROM passkeys WHERE rp_id=?) AS here, EXISTS (SELECT 1 FROM invoices WHERE status='paid') AS paid")
      .bind(currentRpId(env))
      .first<{ passkeys: number; here: number; paid: number }>(),
    // A bad ENABLED_ASSETS (an unknown id in the var) must not take the Overview down: it just is not a usable wallet.
    usableAssets(env).then((a) => a.length > 0, () => false),
  ]);
  const passkeys = row?.passkeys ?? 0;
  return { passkey: passkeys >= 1, wallet, paidInvoice: row?.paid === 1, webhook: (env.WEBHOOK_URL ?? "") !== "", backupPasskey: (row?.here ?? 0) >= 2 };
}

export const setupComplete = (items: SetupChecklist): boolean => Object.values(items).every(Boolean);

export type ChecklistItem = { id: "passkey" | "wallet" | "paid" | "webhook" | "backup"; label: string; done: boolean; href: string };

const ITEMS: { id: ChecklistItem["id"]; key: keyof SetupChecklist; done: string; todo: string; href: string }[] = [
  { id: "passkey", key: "passkey", done: "Passkey created", todo: "Create a passkey", href: "/admin/passkeys" },
  { id: "wallet", key: "wallet", done: "Wallet connected", todo: "Connect a wallet", href: "/admin/welcome?step=coins" },
  { id: "paid", key: "paidInvoice", done: "First invoice paid", todo: "Take a first payment", href: "/admin/welcome?step=done" },
  { id: "webhook", key: "webhook", done: "Webhook added", todo: "Add a webhook", href: "/admin/welcome?step=done" },
  { id: "backup", key: "backupPasskey", done: "Backup passkey added", todo: "Add a backup passkey", href: "/admin/passkeys" },
];

/** The five items in order, each labelled for its state ("Passkey created" once done, "Add a webhook" while open). */
export const checklistItems = (c: SetupChecklist): ChecklistItem[] =>
  ITEMS.map((i) => ({ id: i.id, label: c[i.key] ? i.done : i.todo, done: c[i.key], href: i.href }));

export async function loadChecklist(env: Env): Promise<ChecklistItem[]> {
  return checklistItems(await setupChecklist(env));
}
