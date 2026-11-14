import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

/*
 * Shield note IVs and randoms (Task 1 review): an AES IV reused under the same key breaks the note encryption, so
 * nothing in src/ may choose one. On the syntax tree of every src/**\/*.ts(x):
 *   - the names gcmIv / ctrIv (identifiers, property keys, member names, strings) appear only in
 *     src/routing/railgun/note.ts, where buildShieldRequest defaults them to crypto.getRandomValues and newShieldNote
 *     draws them (with the note's random) fresh per shield;
 *   - newShieldNote is called only by allowedShield in src/routing/guard.ts, which binds the note into the proof
 *     (the signer recomputes the request from it through shieldRequestFor, also in note.ts).
 */

type N = { type: string; [k: string]: unknown };
const SRC = resolve(__dirname, "../../src");
const IV = /^(gcmIv|ctrIv)$/;
const NOTE = "routing/railgun/note.ts";

function walk(n: unknown, visit: (node: N) => void): void {
  if (Array.isArray(n)) return n.forEach((x) => walk(x, visit));
  if (!n || typeof n !== "object" || typeof (n as N).type !== "string") return;
  visit(n as N);
  for (const [k, v] of Object.entries(n)) if (k !== "type" && v && typeof v === "object") walk(v, visit);
}

/** Every use of an IV name, and every call of newShieldNote, in `code`. */
function uses(file: string, code: string): { iv: string[]; newNote: number } {
  const iv: string[] = [];
  let newNote = 0;
  walk(parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }), (n) => {
    if ((n.type === "Identifier" || n.type === "PrivateIdentifier") && IV.test(n.name as string)) iv.push(n.name as string);
    if (n.type === "Literal" && typeof n.value === "string" && /gcmIv|ctrIv/.test(n.value)) iv.push(`"${n.value}"`);
    if (n.type === "TemplateLiteral" && (n.quasis as N[]).some((q) => /gcmIv|ctrIv/.test((q.value as { cooked: string }).cooked))) iv.push("`template`");
    if (n.type === "CallExpression") {
      const c = n.callee as N;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" ? (c.property as N).name : null;
      if (name === "newShieldNote") newNote++;
    }
  });
  return { iv, newNote };
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });

describe("shield IVs are chosen only in note.ts", () => {
  const all = files(SRC).map((f) => ({ file: relative(SRC, f).split("\\").join("/"), code: readFileSync(f, "utf8") }));

  it("gcmIv / ctrIv appear in src only in note.ts", () => {
    expect(all.length).toBeGreaterThan(60);
    const bad = all.filter((f) => f.file !== NOTE).flatMap((f) => uses(f.file, f.code).iv.map((u) => `${f.file}: ${u}`));
    expect(bad).toEqual([]);
    expect(uses(NOTE, all.find((f) => f.file === NOTE)!.code).iv.length).toBeGreaterThan(0);
  });
  it("note.ts draws the random and both IVs per note from crypto.getRandomValues(new Uint8Array(16))", () => {
    const code = all.find((f) => f.file === NOTE)!.code;
    let fn: N | null = null;
    walk(parseAst(code, { lang: "ts" }), (n) => {
      if (n.type === "FunctionDeclaration" && (n.id as N | null)?.name === "newShieldNote") fn = n;
    });
    expect(fn).not.toBeNull();
    // crypto.getRandomValues(new Uint8Array(16)), exactly: the random, gcmIv and ctrIv of the note.
    let draws = 0;
    walk((fn as unknown as N).body, (n) => {
      if (n.type !== "CallExpression") return;
      const c = n.callee as N;
      const arg = (n.arguments as N[])[0];
      const isDraw =
        c.type === "MemberExpression" && (c.object as N).type === "Identifier" && (c.object as N).name === "crypto" && (c.property as N).name === "getRandomValues" &&
        arg?.type === "NewExpression" && (arg.callee as N).name === "Uint8Array" && ((arg.arguments as N[])[0] as N | undefined)?.value === 16;
      if (isDraw) draws++;
    });
    expect(draws).toBe(3);
  });
  it("newShieldNote is called only from routing/guard.ts (allowedShield), once", () => {
    const calls = all.map((f) => ({ file: f.file, n: uses(f.file, f.code).newNote })).filter((x) => x.n > 0);
    expect(calls).toEqual([{ file: "routing/guard.ts", n: 1 }]);
  });
  it("catches the spellings", () => {
    for (const code of [
      `buildShieldRequest({ ...x, gcmIv: iv });`,
      `const ctrIv = new Uint8Array(16);`,
      `o["gcmIv"] = iv;`,
      "o[`ctrIv`] = iv;",
      `const { gcmIv } = note;`,
      `note.ctrIv;`,
    ])
      expect(uses("routing/railgun/execute.ts", code).iv, code).not.toEqual([]);
    expect(uses("x.ts", `n.newShieldNote(a); newShieldNote(b);`).newNote).toBe(2);
  });
});
