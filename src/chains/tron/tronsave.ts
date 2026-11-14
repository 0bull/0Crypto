/**
 * TronSave energy rental (https://api.tronsave.io, header `apikey: TRONSAVE_API_KEY`), used only by the Tron sweeper.
 *
 * ASSUMPTION (not verified against a live TronSave account; everything TronSave-specific is isolated in this file):
 *   POST /v2/estimate-buy-resource  { receiver, resourceType: "ENERGY", resourceAmount, durationSec }
 *     -> { error: false, message, data: { unitPrice: number (sun per energy), durationSec, estimateTrx: number (in SUN), availableResource? } }
 *   POST /v2/buy-resource           { receiver, resourceType: "ENERGY", resourceAmount, durationSec, unitPrice }
 *     -> { error: false, message, data: { orderId: string } }
 *   A refusal is { error: true, message }. The order is paid from the TronSave account's prepaid balance, not from the
 *   hot wallet. `unitPrice` from the estimate is passed back so the order cannot be filled above it.
 *
 * Failing closed, because a buy spends money:
 *   - An estimate places no order, so every odd estimate answer is a definite failure (retry later, never buy on it).
 *     estimateTrx must be at least unitPrice x amount: a unit mix-up (TRX for sun, say) can never look cheap.
 *   - A buy is a definite refusal only on { error: true } or HTTP 400/401/403/429. Anything else (other envelopes, a
 *     missing orderId, 5xx, other 4xx, non-JSON, timeouts, network errors) may have placed an order: the caller must
 *     wait for the energy and never buy a second time for that attempt.
 */
import { EXPLORER_TIMEOUT_MS, ExplorerHttpError, explorerFetch } from "../utxo/explorer";
import type { Env } from "../../env";

export const TRONSAVE_API = "https://api.tronsave.io";
/** Rentals last one hour; the sweeper gives up waiting for the energy well before (ENERGY_WAIT_MS). */
export const RENT_DURATION_SEC = 3600;
/** HTTP statuses of a buy that mean TronSave refused it (no order). */
const DEFINITE_BUY_STATUS = new Set([400, 401, 403, 429]);

/**
 * `definite`: no order was placed (refusal, unusable estimate, price over the cap); the rental may be tried again.
 * Otherwise an order may exist: the caller waits for the energy (or its timeout) instead of renting twice.
 */
export class TronSaveError extends Error {
  constructor(
    message: string,
    readonly definite: boolean,
    readonly tooExpensive = false,
  ) {
    super(message);
    this.name = "TronSaveError";
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

async function post(env: Pick<Env, "TRONSAVE_API_KEY">, path: string, payload: Json, timeoutMs: number): Promise<{ status: number; body: unknown } | { error: "network" | "http"; status?: number }> {
  let res: Response;
  try {
    res = await explorerFetch(
      `${TRONSAVE_API}${path}`,
      { method: "POST", headers: { "content-type": "application/json", apikey: env.TRONSAVE_API_KEY ?? "" }, body: JSON.stringify(payload) },
      timeoutMs,
    );
  } catch (e) {
    return e instanceof ExplorerHttpError ? { error: "http", status: e.status } : { error: "network" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** What renting `amount` energy for an hour would cost, in sun. Every odd answer is a definite TronSaveError. */
export async function estimateEnergy(
  env: Pick<Env, "TRONSAVE_API_KEY">,
  receiver: string,
  amount: number,
  timeoutMs = EXPLORER_TIMEOUT_MS,
): Promise<{ costSun: bigint; unitPrice: number }> {
  const r = await post(env, "/v2/estimate-buy-resource", { receiver, resourceType: "ENERGY", resourceAmount: amount, durationSec: RENT_DURATION_SEC }, timeoutMs);
  const no = (why: string): never => {
    throw new TronSaveError(`tronsave estimate: ${why}`, true);
  };
  if ("error" in r) return no(r.error === "http" ? `HTTP ${r.status}` : "network error");
  const b = r.body;
  if (!isObj(b) || b.error !== false || !isObj(b.data)) return no("unusable answer");
  const { estimateTrx, unitPrice, availableResource } = b.data;
  if (typeof estimateTrx !== "number" || !Number.isSafeInteger(estimateTrx) || estimateTrx < 0) return no("no usable price");
  if (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice <= 0) return no("no unit price");
  if (estimateTrx < unitPrice * amount) return no("total below unit price x amount (unit mix-up?)");
  if (availableResource !== undefined && (typeof availableResource !== "number" || availableResource < amount)) return no("not enough energy on offer");
  return { costSun: BigInt(estimateTrx), unitPrice };
}

/**
 * Rents `amount` energy for `receiver` for an hour: estimate first; refuse (definite, tooExpensive) when the unit price
 * is over `maxSunPerUnit` or the total over maxSunPerUnit x amount; then buy at the estimated unit price. Returns
 * TronSave's order id. See the module comment for which buy failures are definite.
 */
export async function rentEnergy(
  env: Pick<Env, "TRONSAVE_API_KEY">,
  receiver: string,
  amount: number,
  maxSunPerUnit: number,
  timeoutMs = EXPLORER_TIMEOUT_MS,
): Promise<string> {
  const est = await estimateEnergy(env, receiver, amount, timeoutMs);
  const cap = BigInt(maxSunPerUnit) * BigInt(amount);
  if (est.unitPrice > maxSunPerUnit || est.costSun > cap)
    throw new TronSaveError(`${amount} energy at ${est.unitPrice} sun each (${est.costSun} sun) is over the ${maxSunPerUnit} sun/energy cap`, true, true);
  const r = await post(env, "/v2/buy-resource", { receiver, resourceType: "ENERGY", resourceAmount: amount, durationSec: RENT_DURATION_SEC, unitPrice: est.unitPrice }, timeoutMs);
  if ("error" in r) {
    if (r.error === "http" && DEFINITE_BUY_STATUS.has(r.status!)) throw new TronSaveError(`tronsave buy: refused (HTTP ${r.status})`, true);
    throw new TronSaveError(`tronsave buy: ${r.error === "http" ? `HTTP ${r.status}` : "network error or timeout"}; an order may exist`, false);
  }
  const b = r.body;
  if (isObj(b) && b.error === true) throw new TronSaveError("tronsave buy: refused", true);
  if (!isObj(b) || b.error !== false || !isObj(b.data) || typeof b.data.orderId !== "string" || b.data.orderId === "")
    throw new TronSaveError("tronsave buy: unrecognised answer; an order may exist", false);
  return b.data.orderId.slice(0, 100);
}
