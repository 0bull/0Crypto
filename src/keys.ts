import { base64urlnopad } from "@scure/base";

/**
 * Keys the Worker makes for itself, so a deploy with blank secrets still works (src/settings.ts effectiveEnv uses them
 * when SESSION_SECRET or WEBHOOK_SECRET is empty). Stored in D1 `instance_keys`. HMAC keys only: they sign session
 * cookies and webhook bodies, never money. Values are never logged.
 */
export type InstanceKeyName = "session" | "webhook";

/** 32 random bytes as unpadded base64url: 43 characters. */
const freshKey = (): string => base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * The instance key `name`, created on first use. Concurrency-safe: every caller inserts its own candidate with
 * ON CONFLICT DO NOTHING, then reads the row back, so racing isolates all end up with the one value that was stored first.
 */
export async function instanceKey(db: D1Database, name: InstanceKeyName): Promise<string> {
  const [, read] = await db.batch<{ value: string }>([
    db.prepare("INSERT INTO instance_keys(name,value,created_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING").bind(name, freshKey(), Date.now()),
    db.prepare("SELECT value FROM instance_keys WHERE name=?").bind(name),
  ]);
  const value = read?.results[0]?.value;
  if (!value) throw new Error(`instance key ${name} could not be read`);
  return value;
}

/**
 * Replaces the webhook instance key and returns the new raw value (the effective WEBHOOK_SECRET is `whsec_` + it).
 * The caller drops the settings cache (clearSettingsCache) so this isolate signs with the new key at once.
 */
export async function rotateWebhookKey(db: D1Database): Promise<string> {
  const value = freshKey();
  // An upsert, so a rotation before the key was ever used still stores what it returns.
  await db
    .prepare("INSERT INTO instance_keys(name,value,created_at) VALUES('webhook',?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
    .bind(value, Date.now())
    .run();
  return value;
}
