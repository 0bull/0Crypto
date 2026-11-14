import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix, relative, resolve } from "node:path";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

/*
 * The spending guard's perimeter, checked on the syntax tree of every src/**\/*.ts(x) (oxc's TypeScript parser, via
 * rolldown/parseAst: TypeScript 7 ships no ts.createSourceFile). The guard (src/routing/guard.ts) is only as strong as
 * these rules:
 *   1. Key material and signing libraries stay in src/signing. The modules that can sign or derive private keys
 *      (RESTRICTED) may be imported, statically or with import(), only by src/signing/* and the files in
 *      IMPORT_ALLOW, each for a written reason. src/signing/keys.ts and evmkeys.ts (private keys) are imported by
 *      nothing outside src/signing; the other src/signing modules only for the names in SIGNING_API.
 *   2. Outside src/signing, a curve object (secp256k1, ed25519) is only ever read as .getPublicKey, .Point or .utils:
 *      a bare reference, alias, `as` cast, renamed or namespace import, re-export or computed access is a violation.
 *   3. Outside src/signing, no member access, element access (string literal, template or concatenation), call,
 *      destructuring or identifier-shaped string literal names anything matching /sign|finali[sz]e(?!d)/i, and no
 *      sendRawTransaction / sendTransaction / writeContract, eval, Function or `with`, except the counted
 *      EXCEPTIONS and calls to the imported SIGNING_API signers.
 *      nostr-tools (Nostr event signing, NIP-44/NIP-04) is restricted the same way: Nostr events are not money, but
 *      the NWC client key must stay in src/signing/nostr.ts, which hands out only a secret-free connection handle.
 *   5. Every bare import in src (value or type) names a package in package.json `dependencies`, a node builtin or a
 *      `cloudflare:` platform module: no devDependency (ox, ethers, tronweb, ...) can reach the worker. Outside
 *      src/signing, fromMasterSeed, privateKey and privateExtendedKey are never accessed, called, destructured or
 *      spelled as a string.
 *   4. src/signing exports only declarations (no `export {}`, `export *`, `export default`); a signer module's
 *      exported functions take `proofs` (except the listed ones), and addresses.ts exports only address helpers.
 */

type N = { type: string; [k: string]: unknown };
const SRC = resolve(__dirname, "../../src");

// "finalized" (the block tag / commitment, chain finality) is not btc-signer's finalize(), finalizeIdx().
const SIGN = /sign|finali[sz]e(?!d)/i;
const PRIMITIVE = /^(sendRawTransaction|sendTransaction|writeContract)$/;
const CURVE = /^@noble\/(curves\/(secp256k1|ed25519)|secp256k1|ed25519)/;
const RESTRICTED = [/^@noble\/curves\//, /^@noble\/(secp256k1|ed25519)$/, /^viem\/accounts/, /^@scure\/bip32/, /^@scure\/btc-signer/, /^@solana\/(kit|keys|signers|transactions)/, /^nostr-tools(\/|$)/];
const CURVE_MEMBERS = new Set(["getPublicKey", "Point", "utils"]);
const KEY_MATERIAL = /^(fromMasterSeed|privateKey|privateExtendedKey)$/;
const PKG = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { dependencies: Record<string, string> };
const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
/** A bare specifier that is not a runtime dependency, a node builtin or a cloudflare: module. */
const notADependency = (spec: string) => !spec.startsWith(".") && !spec.startsWith("cloudflare:") && !isBuiltin(spec) && !Object.hasOwn(PKG.dependencies, packageOf(spec));

/** Who may import a restricted module outside src/signing, and why. */
const IMPORT_ALLOW: Record<string, { modules: string[]; why: string }> = {
  "chains/solana/pda.ts": { modules: ["@noble/curves/ed25519.js"], why: "Point.fromBytes: the off-curve test of program derived addresses" },
  "routing/railgun/address.ts": { modules: ["@noble/curves/ed25519.js"], why: "Point.fromBytes: validates the receiver's viewing public key" },
  "routing/railgun/note.ts": { modules: ["@noble/curves/ed25519.js"], why: "note ECDH: Point, its Fn order, and getPublicKey of the shield key" },
  "chains/solana/sweeptx.ts": { modules: ["@solana/kit"], why: "builds, compiles and decodes sweep messages; signs nothing (rule 3 still applies)" },
  "chains/utxo/derive.ts": { modules: ["@scure/bip32", "@scure/btc-signer"], why: "public xpub import/derivation and p2pkh/p2wpkh address encoding" },
  "routing/addr.ts": { modules: ["@scure/btc-signer"], why: "Address decoding to validate UTXO deposit addresses" },
  "chains/utxo/spend.ts": { modules: ["@scure/btc-signer"], why: "Address/OutScript: output scripts of routing spends and the addresses they pay (no keys)" },
  "chains/solana/routetx.ts": { modules: ["@solana/kit"], why: "builds, compiles and decodes the routing tx; signs nothing (rule 3 still applies)" },
};

/** What code outside src/signing may import from it (type-only imports are always fine). */
const SIGNING_API: Record<string, string[]> = {
  "signing/evm": ["signEvmTx", "railgunShieldKey"],
  "signing/tron": ["signTronTx"],
  "signing/solana": ["signSolanaTx"],
  "signing/utxo": ["buildUtxoSpend"],
  "signing/addresses": ["tronHotAddress", "tronDepositAddress", "solHotAddress", "solDepositAddress", "evmHotAddress", "accountFromSeed"],
  // NIP-47 client (chains/lightning/nwc.ts): a secret-free connection handle, request events, response decryption and
  // event verification. Nostr events move no money; the NWC secret never leaves the module.
  "signing/nostr": ["parseNwcUri", "nwcClientPubkey", "nwcRequestEvent", "nwcOpenResponse", "nostrEventValid"],
};
const SIGNERS = new Set(["signEvmTx", "signTronTx", "signSolanaTx"]);

/** Counted exceptions to rule 3, by file: `<kind>:<name>` -> count, with the reason. */
const EXCEPTIONS: Record<string, { counts: Record<string, number>; why: string }> = {
  "admin/session.ts": { counts: { "member:sign": 1, "string:sign": 1 }, why: "crypto.subtle.sign HMAC of the session cookie (and its importKey usage)" },
  "admin/auth.tsx": { counts: { "call:signSession": 1 }, why: "HMAC session cookie (admin/session.ts)" },
  "webhooks/sign.ts": { counts: { "member:sign": 1, "string:sign": 1 }, why: "crypto.subtle.sign HMAC of the webhook body (and its importKey usage)" },
  "webhooks/consumer.ts": {
    counts: { "call:signWebhook": 1, "call:postSigned": 2 },
    why: "the webhook HMAC (webhooks/sign.ts), in postSigned only; postSigned is called by the queue delivery and the admin test event",
  },
  "routing/railgun/note.ts": { counts: { "member:signMessage": 1 }, why: "the Railgun shield key: the account comes from railgunShieldKey in src/signing/evm.ts" },
  "sweep/evm.ts": {
    counts: { "member:sendRawTransaction": 2, "call:signReq": 2 },
    why: "broadcasts bytes signEvmTx signed (the hash is recorded in D1 between signing and broadcast); signReq is the sweeper's wrapper that calls signEvmTx",
  },
  "routing/railgun/execute.ts": {
    counts: { "member:sendRawTransaction": 2 },
    why: "broadcasts bytes signEvmTx signed (wrap, approve, shield) after the caller persisted them, and re-broadcasts those same persisted bytes",
  },
  "sweep/tron.ts": { counts: { "call:encodeSignedTx": 1, "member:signature": 2 }, why: "wire-encodes signTronTx's output; reads the signature it returned" },
  "sweep/solana.ts": {
    counts: { "destructure:signature": 1, "string:signed": 3, "string:getSignatureStatuses": 1, "string:sendTransaction": 1 },
    why: "signSolanaTx's result; the 'signed' sweep step; RPC method names (status lookup, and the broadcast of the signed wire tx)",
  },
  "chains/solana/sweeptx.ts": {
    counts: { "member:createNoopSigner": 2, "member:signatures": 1, "member:numSignerAccounts": 1, "destructure:numSignerAccounts": 1, "destructure:numReadonlySignerAccounts": 1, "destructure:numReadonlyNonSignerAccounts": 1 },
    why: "Kit no-op signers (account roles only, no key) and the compiled message's header and empty signature slots",
  },
  "chains/solana/routetx.ts": {
    counts: { "member:createNoopSigner": 1, "member:signatures": 1, "member:numSignerAccounts": 2, "member:numReadonlySignerAccounts": 1, "member:numReadonlyNonSignerAccounts": 1 },
    why: "Kit no-op signer (account role only, no key) for the hot wallet, the compiled tx's empty signature slots, and the decoded header's signer counts (self-check)",
  },
  "routing/swap.ts": {
    counts: { "call:encodeSignedTx": 1, "member:signature": 2, "string:sendTransaction": 2, "string:getSignatureStatuses": 1 },
    why: "wire-encodes signTronTx's output and reads the signatures signTronTx/signSolanaTx returned; Solana RPC method names (broadcast and re-broadcast of the persisted wire tx, status lookup)",
  },
  "chains/tron/trongrid.ts": { counts: { "call:unsigned": 2 }, why: "parses node-built UNsigned txs" },
  "routing/refund.ts": {
    counts: { "member:sendRawTransaction": 1, "member:signature": 1, "string:sendTransaction": 1 },
    why: "refund sends: broadcasts the bytes signEvmTx signed (after the refund row recorded their hash), reads signSolanaTx's signature, and names the Solana broadcast RPC method",
  },
};

/** Signer-module exports that do not take proofs, and why. */
const NO_PROOFS: Record<string, string> = { "signing/evm.ts:railgunShieldKey": "derives the Railgun shield (note encryption) key; it spends nothing" };
const ADDRESS_EXPORTS = new Set(SIGNING_API["signing/addresses"]);
const SIGNER_MODULES = new Set(["signing/evm.ts", "signing/tron.ts", "signing/solana.ts", "signing/utxo.ts"]);
const INTERNAL = new Set(["signing/keys", "signing/evmkeys"]);
const SIGNING_FILES = ["signing/addresses.ts", "signing/evm.ts", "signing/evmkeys.ts", "signing/keys.ts", "signing/nostr.ts", "signing/solana.ts", "signing/tron.ts", "signing/utxo.ts"];

function walk(n: unknown, visit: (node: N, parent: N | null, key: string) => void, parent: N | null = null, key = ""): void {
  if (Array.isArray(n)) {
    for (const x of n) walk(x, visit, parent, key);
    return;
  }
  if (!n || typeof n !== "object" || typeof (n as N).type !== "string") return;
  visit(n as N, parent, key);
  for (const [k, v] of Object.entries(n)) if (k !== "type" && v && typeof v === "object") walk(v, visit, n as N, k);
}

/** A string the expression always evaluates to (literals, templates and + of those), or null. */
function fold(n: N | undefined | null): string | null {
  if (!n) return null;
  if (n.type === "Literal" && (typeof n.value === "string" || typeof n.value === "number")) return String(n.value);
  if (n.type === "TemplateLiteral") {
    const parts = (n.quasis as N[]).map((q) => (q.value as { cooked: string }).cooked);
    const ex = (n.expressions as N[]).map(fold);
    if (ex.some((x) => x === null)) return null;
    return parts.map((p, i) => p + (ex[i] ?? "")).join("");
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const l = fold(n.left as N);
    const r = fold(n.right as N);
    return l === null || r === null ? null : l + r;
  }
  return null;
}
const nameOf = (n: N, computed: boolean): string | null => (computed ? fold(n) : n.type === "Identifier" || n.type === "PrivateIdentifier" ? (n.name as string) : fold(n));
const resolveRel = (file: string, spec: string): string | null => (spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.(tsx?|js)$/, "") : null);

/** Every violation of rules 1-3 in `code`, as if it were src/<file>. Counted exceptions are applied by the caller. */
function violations(file: string, code: string): string[] {
  const out: string[] = [];
  const inSigning = file.startsWith("signing/");
  const ast = parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }) as unknown as N;
  const curveNames = new Set<string>();
  const signerNames = new Set<string>();
  const curveSpecifiers = new Set<N>();

  const checkSource = (spec: string, what: string, names: string[] | null, typeOnly: boolean) => {
    if (notADependency(spec)) out.push(`dependency:${spec} (not in package.json dependencies)`);
    if (typeOnly || inSigning) return;
    if (RESTRICTED.some((r) => r.test(spec)) && !IMPORT_ALLOW[file]?.modules.includes(spec)) out.push(`import:${spec}`);
    const target = resolveRel(file, spec);
    if (target === null || !target.startsWith("signing/")) return;
    if (INTERNAL.has(target)) out.push(`import:${target} (private keys)`);
    else if (names === null) out.push(`${what}:${target} (names cannot be checked)`);
    else for (const n of names) if (!SIGNING_API[target]?.includes(n)) out.push(`import:${target}.${n}`);
  };

  walk(ast, (n, parent, key) => {
    switch (n.type) {
      case "ImportDeclaration": {
        const spec = (n.source as N).value as string;
        const specs = n.specifiers as N[];
        const typeOnly = n.importKind === "type" || (specs.length > 0 && specs.every((s) => s.importKind === "type"));
        const names = specs.filter((s) => s.importKind !== "type").map((s) => (s.type === "ImportSpecifier" ? ((s.imported as N).name as string) : null));
        checkSource(spec, "import", names.includes(null) ? null : (names as string[]), typeOnly);
        for (const s of specs) {
          const local = (s.local as N).name as string;
          if (CURVE.test(spec) && !inSigning) {
            if (s.type !== "ImportSpecifier") out.push(`curve:${local} (namespace or default import)`);
            else if ((s.imported as N).name !== local) out.push(`curve:${local} (renamed import)`);
            curveNames.add(local);
            curveSpecifiers.add(s.local as N);
          }
          if (s.type === "ImportSpecifier" && SIGNERS.has(local) && resolveRel(file, spec)?.startsWith("signing/")) signerNames.add(local);
        }
        break;
      }
      case "ImportExpression": {
        const spec = fold(n.source as N);
        if (spec === null) {
          if (!inSigning) out.push("import:(computed specifier)");
        } else {
          checkSource(spec, "dynamic import", null, false);
          if (CURVE.test(spec) && !inSigning && IMPORT_ALLOW[file]) out.push(`curve:dynamic import of ${spec}`);
        }
        break;
      }
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        const src = n.source as N | null;
        if (!src) break;
        const spec = src.value as string;
        const names = n.type === "ExportAllDeclaration" ? null : (n.specifiers as N[]).map((s) => (s.local as N).name as string);
        checkSource(spec, "re-export", names, n.exportKind === "type");
        if (CURVE.test(spec) && !inSigning) out.push(`curve:re-export of ${spec}`);
        break;
      }
      case "Identifier": {
        if (inSigning || !curveNames.has(n.name as string) || curveSpecifiers.has(n)) break;
        if (parent?.type === "ImportSpecifier") break;
        if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) break;
        if (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand) break;
        const ok = parent?.type === "MemberExpression" && key === "object" && !parent.computed && CURVE_MEMBERS.has((parent.property as N).name as string);
        if (!ok) out.push(`curve:${n.name as string} (used other than .${[...CURVE_MEMBERS].join("/.")})`);
        break;
      }
      case "MemberExpression": {
        if (inSigning) break;
        const name = nameOf(n.property as N, n.computed === true);
        if (name !== null && (SIGN.test(name) || PRIMITIVE.test(name) || KEY_MATERIAL.test(name))) out.push(`member:${name}`);
        break;
      }
      case "CallExpression":
      case "NewExpression": {
        if (inSigning) break;
        const c = n.callee as N;
        if (c.type === "Identifier") {
          const name = c.name as string;
          if (name === "eval" || name === "Function") out.push(`call:${name}`);
          else if ((SIGN.test(name) && !signerNames.has(name)) || KEY_MATERIAL.test(name)) out.push(`call:${name}`);
        }
        break;
      }
      case "ObjectPattern": {
        if (inSigning) break;
        for (const p of n.properties as N[]) {
          if (p.type !== "Property") continue;
          const name = nameOf(p.key as N, p.computed === true);
          if (name !== null && (SIGN.test(name) || PRIMITIVE.test(name) || KEY_MATERIAL.test(name))) out.push(`destructure:${name}`);
        }
        break;
      }
      case "Literal": {
        if (inSigning || typeof n.value !== "string") break;
        if (parent?.type === "MemberExpression" && key === "property") break; // counted as member access
        if (parent?.type === "Property" && key === "key") break; // object keys and destructuring (counted there)
        if (["ImportDeclaration", "ImportExpression", "ExportNamedDeclaration", "ExportAllDeclaration", "TSImportType"].includes(parent?.type ?? "")) break;
        const v = n.value;
        if (/^[A-Za-z_$][\w$]*$/.test(v) && (SIGN.test(v) || PRIMITIVE.test(v) || KEY_MATERIAL.test(v))) out.push(`string:${v}`);
        break;
      }
      case "TSImportType": {
        const spec = ((n.source as N | undefined)?.value as string | undefined) ?? (((n.argument as N | undefined)?.literal as N | undefined)?.value as string | undefined);
        if (spec && notADependency(spec)) out.push(`dependency:${spec} (not in package.json dependencies)`);
        break;
      }
      case "WithStatement":
        if (!inSigning) out.push("with");
        break;
    }
  });
  return out;
}

/** Violations of rule 4 (src/signing export shapes). */
function exportViolations(file: string, code: string): string[] {
  const out: string[] = [];
  const ast = parseAst(code, { lang: "ts" }) as unknown as N;
  for (const st of ast.body as N[]) {
    if (st.type === "ExportDefaultDeclaration") out.push("export default");
    if (st.type === "ExportAllDeclaration") out.push("export *");
    if (st.type !== "ExportNamedDeclaration") continue;
    if (!st.declaration) {
      if (st.exportKind !== "type") out.push(`export { ${(st.specifiers as N[]).map((s) => (s.local as N).name).join(", ")} }`);
      continue;
    }
    const d = st.declaration as N;
    if (d.type === "TSTypeAliasDeclaration" || d.type === "TSInterfaceDeclaration" || st.exportKind === "type") continue;
    if (d.type !== "FunctionDeclaration") {
      out.push(`export ${d.type}`);
      continue;
    }
    const name = (d.id as N).name as string;
    const params = (d.params as N[]).map((p) => (p.type === "Identifier" ? (p.name as string) : p.type === "AssignmentPattern" ? ((p.left as N).name as string) : ""));
    if (SIGNER_MODULES.has(file) && !params.includes("proofs") && !NO_PROOFS[`${file}:${name}`]) out.push(`${name} does not take proofs`);
    if (file === "signing/addresses.ts" && !ADDRESS_EXPORTS.has(name)) out.push(`${name} is not a listed address helper`);
  }
  return out;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
const rel = (p: string) => relative(SRC, p).split("\\").join("/");

/** Raw violations minus the counted exceptions: a file must use each exception exactly as often as listed. */
function offenders(file: string, code: string): string[] {
  const v = violations(file, code);
  const ex = EXCEPTIONS[file]?.counts ?? {};
  const counts = new Map<string, number>();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out = v.filter((x) => ex[x] === undefined);
  for (const [k, n] of Object.entries(ex)) if ((counts.get(k) ?? 0) !== n) out.push(`${k} x${counts.get(k) ?? 0}, expected x${n}`);
  return out;
}

describe("signing perimeter (src/)", () => {
  const all = files(SRC).map((f) => ({ file: rel(f), code: readFileSync(f, "utf8") }));

  it("walks the real tree", () => {
    expect(all.length).toBeGreaterThan(60);
    expect(all.map((f) => f.file).filter((f) => f.startsWith("signing/")).sort()).toEqual(SIGNING_FILES);
  });
  it("rules 1-3 hold in every file, with exactly the counted exceptions", () => {
    const bad = all.flatMap(({ file, code }) => offenders(file, code).map((v) => `${file}: ${v}`));
    expect(bad).toEqual([]);
  });
  it("every allowlisted import and exception is still used (no stale allowances)", () => {
    for (const [file, a] of Object.entries(IMPORT_ALLOW)) {
      const code = all.find((f) => f.file === file)?.code ?? "";
      for (const m of a.modules) expect(code, `${file} ${m}`).toContain(`"${m}"`);
    }
    for (const file of Object.keys(EXCEPTIONS)) expect(all.some((f) => f.file === file), file).toBe(true);
  });
  it("rule 4: src/signing exports only declarations, signers take proofs, addresses.ts only address helpers", () => {
    const bad = all.filter((f) => f.file.startsWith("signing/")).flatMap(({ file, code }) => exportViolations(file, code).map((v) => `${file}: ${v}`));
    expect(bad).toEqual([]);
  });
});

describe("signing perimeter: bypass spellings are caught", () => {
  const AT = "sweep/fixture.ts";
  const PDA = "chains/solana/pda.ts"; // allowed to import ed25519: only the member rule stands in the way
  const cases: [string, string, string][] = [
    ["bracket access with a string literal", AT, `acct["signTransaction"](tx);`],
    ["destructuring the method", AT, `const { signTransaction } = acct; signTransaction(tx);`],
    ["destructuring with an alias", AT, `const { signTransaction: st } = acct; st(tx);`],
    ["template-literal element access", AT, "acct[`sign${'Transaction'}`](tx);"],
    ["concatenated element access", AT, `acct["sign" + "Message"]({ message: "x" });`],
    ["Reflect.get with the method name", AT, `Reflect.get(acct, "signTransaction").call(acct, tx);`],
    ["btc-signer signIdx and finalize", AT, `tx.signIdx(k, 0); tx.finalize();`],
    ["a curve alias", PDA, `import { ed25519 } from "@noble/curves/ed25519.js"; const e = ed25519; e.sign(m, k);`],
    ["a curve cast", PDA, `import { ed25519 } from "@noble/curves/ed25519.js"; (ed25519 as any).sign(m, k);`],
    ["a renamed curve import", PDA, `import { ed25519 as e } from "@noble/curves/ed25519.js"; e.getPublicKey(k);`],
    ["a namespace curve import", PDA, `import * as c from "@noble/curves/ed25519.js"; c.ed25519.sign(m, k);`],
    ["computed curve access", PDA, `import { ed25519 } from "@noble/curves/ed25519.js"; ed25519["utils"]; ed25519[x](m, k);`],
    ["destructuring the curve", PDA, `import { ed25519 } from "@noble/curves/ed25519.js"; const { sign } = ed25519; sign(m, k);`],
    ["a dynamic curve import", PDA, `const m = await import("@noble/curves/ed25519.js"); m.ed25519.getPublicKey(k);`],
    ["a curve import where none is allowed", AT, `import { secp256k1 } from "@noble/curves/secp256k1.js"; secp256k1.getPublicKey(k);`],
    ["a dynamic import of a signing library", AT, `const { mnemonicToAccount } = await import("viem/accounts");`],
    ["a computed import specifier", AT, `await import("viem/" + "accounts");`],
    ["re-exporting a curve", PDA, `export { ed25519 } from "@noble/curves/ed25519.js";`],
    ["importing private keys from src/signing", AT, `import { tronHotKey } from "../signing/keys"; tronHotKey(seed);`],
    ["dynamically importing the EVM account", AT, `const { hotAccount } = await import("../signing/evmkeys");`],
    ["importing a non-API name from a signer module", AT, `import { requirePays } from "../signing/tron";`],
    ["a namespace import of a signer module", AT, `import * as t from "../signing/tron"; t.signTronTx(s, k, r, p);`],
    ["a locally defined sign function", AT, `function signIt(k: Uint8Array) { return k; } signIt(k);`],
    ["sendRawTransaction where it is not counted", AT, `client.sendRawTransaction({ serializedTransaction: raw });`],
    ["eval", AT, `eval("acct.signTransaction(tx)");`],
    ["hotAccount(env).sign({ hash })", AT, `hotAccount(env).sign({ hash });`],
    ["deriveChild(0).sign(hash)", AT, `account.deriveChild(0).sign(hash);`],
    ["btc-signer tx.sign", AT, `tx.sign(priv);`],
    ["Kit partiallySignTransaction", AT, `await partiallySignTransaction([kp], tx);`],
    ["Kit signBytes", AT, `await signBytes(key, bytes);`],
    ["a call with a space before the parenthesis", AT, `acct.signTransaction (tx);`],
    ["a member alias of a curve method", PDA, `import { ed25519 } from "@noble/curves/ed25519.js"; const s = ed25519.sign; s(m, k);`],
    ["fromMasterSeed", AT, `HDKey.fromMasterSeed(seed);`],
    ["reading privateKey", AT, `const k = node.privateKey;`],
    ["destructuring privateExtendedKey", AT, `const { privateExtendedKey } = node;`],
    ["privateKey by string", AT, `node["privateKey"];`],
    ["a devDependency (ethers)", AT, `import { Wallet } from "ethers";`],
    ["a devDependency (ox), dynamically", AT, `await import("ox");`],
    ["a devDependency (tronweb), type-only", AT, `import type { TronWeb } from "tronweb";`],
    ["an undeclared package", AT, `import x from "left-pad";`],
    ["new Function", AT, `new Function("a", "return a.sign()")(acct);`],
    ["nostr-tools outside src/signing", "chains/lightning/nwc.ts", `import { finalizeEvent } from "nostr-tools/pure";`],
    ["nostr-tools dynamically, outside src/signing", "chains/lightning/nwc.ts", `const { verifyEvent } = await import("nostr-tools/pure");`],
    ["a non-API name from signing/nostr", "chains/lightning/nwc.ts", `import { secretOf } from "../../signing/nostr";`],
  ];
  for (const [what, file, code] of cases) it(what, () => expect(violations(file, code), code).not.toEqual([]));

  it("allowed shapes pass", () => {
    expect(violations(PDA, `import { ed25519 } from "@noble/curves/ed25519.js"; ed25519.Point.fromBytes(b); ed25519.getPublicKey(k); ed25519.utils.randomSecretKey();`)).toEqual([]);
    expect(violations(AT, `import { signTronTx } from "../signing/tron"; import { tronHotAddress } from "../signing/addresses"; signTronTx(s, { role: "hot" }, r, [p]); tronHotAddress(s);`)).toEqual([]);
    expect(violations(AT, `import type { TronKey } from "../signing/keys"; let k: TronKey;`)).toEqual([]);
    expect(violations(AT, `import { readFileSync } from "node:fs"; import { env } from "cloudflare:workers"; import { Hono } from "hono"; import { sha256 } from "@noble/hashes/sha2.js";`)).toEqual([]);
  });
  it("export shapes", () => {
    expect(exportViolations("signing/tron.ts", `function a() {} export { a };`)).not.toEqual([]);
    expect(exportViolations("signing/tron.ts", `export default function a() {}`)).not.toEqual([]);
    expect(exportViolations("signing/tron.ts", `export * from "./keys";`)).not.toEqual([]);
    expect(exportViolations("signing/tron.ts", `export const raw = (k: Uint8Array) => k;`)).not.toEqual([]);
    expect(exportViolations("signing/tron.ts", `export function raw(k: Uint8Array) { return k; }`)).not.toEqual([]);
    expect(exportViolations("signing/addresses.ts", `export function hotPriv(seed: string) { return seed; }`)).not.toEqual([]);
    expect(exportViolations("signing/tron.ts", `export type T = 1; export function signTronTx(seed: string, proofs: unknown[]) {}`)).toEqual([]);
  });
});
