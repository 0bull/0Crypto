// Migration 0026: passkeys get the RP ID they were created for, backfilled from the host of the D1 PUBLIC_URL.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";

const e = env as unknown as Env;
const all = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

describe("0026_passkey_rp", () => {
  it("adds rp_id and backfills it from the host of the D1 PUBLIC_URL (without the port)", async () => {
    expect(all.some((m) => m.name === "0026_passkey_rp.sql")).toBe(true);
    // A dev DB that applied 0024 and 0025 before rp_id existed.
    await applyD1Migrations(e.DB, all.filter((m) => m.name < "0026"));
    await e.DB.prepare("INSERT INTO passkeys(id,public_key,counter,transports,name,created_at) VALUES('pk1',x'00',0,NULL,'Passkey 1',1)").run();
    await e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('PUBLIC_URL','https://pay.example.com:8443',1)").run();
    await applyD1Migrations(e.DB, all);
    expect(await e.DB.prepare("SELECT rp_id FROM passkeys WHERE id='pk1'").first()).toEqual({ rp_id: "pay.example.com" });
    // New rows can carry their own.
    await e.DB.prepare("INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id) VALUES('pk2',x'00',0,NULL,'Passkey 2',2,'other.test')").run();
    expect(await e.DB.prepare("SELECT rp_id FROM passkeys WHERE id='pk2'").first()).toEqual({ rp_id: "other.test" });
  });
});
