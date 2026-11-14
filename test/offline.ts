import { http, HttpResponse } from "msw";

/**
 * msw handlers for tests that start watchers or price lookups without testing them: price APIs are down
 * and every default explorer reports an empty chain, so a stray alarm or refresh never changes state
 * (and never reaches the network).
 */
export const offline = () => [
  http.get("https://api.kraken.com/*", () => new HttpResponse(null, { status: 500 })),
  ...["https://mempool.space/api", "https://blockstream.info/api", "https://litecoinspace.org/api"].flatMap((base) => [
    http.get(`${base}/blocks/tip/height`, () => HttpResponse.text("900000")),
    http.get(`${base}/address/:addr/txs`, () => HttpResponse.json([])),
  ]),
];
