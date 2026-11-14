import { Hono } from "hono";
import type { Env } from "../env";
import { Layout, merchantName, page } from "./layout";

/*
 * The gateway's own `/`. Until the gateway is claimed (no passkey yet) it sends the owner to /admin, which shows the
 * setup page. Afterwards it is a neutral page with the shop name only: customers who land here see nothing about
 * 0Crypto, its marketing or other merchants (the marketing site is hosted separately).
 */
export const home = new Hono<{ Bindings: Env }>();

home.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT EXISTS (SELECT 1 FROM passkeys) AS claimed").first<{ claimed: number }>();
  if (row?.claimed !== 1) {
    c.header("cache-control", "no-store");
    return c.redirect("/admin", 302);
  }
  const name = merchantName(c.env);
  return page(
    c,
    <Layout title={name} css={["/checkout.css"]}>
      <main class="page">
        <h1>{name}</h1>
      </main>
    </Layout>,
  );
});
