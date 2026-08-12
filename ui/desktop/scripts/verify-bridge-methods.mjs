import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const rustBridge = new URL("../src-tauri/src/lib.rs", import.meta.url);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

const frontendMethods = new Set();
for (const path of await sourceFiles(sourceRoot)) {
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "bridge"
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])) {
      frontendMethods.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const rust = await readFile(rustBridge, "utf8");
const allowedBlock = rust.match(/const ALLOWED_METHODS:[\s\S]*?=\s*&\[([\s\S]*?)\];/);
if (!allowedBlock) throw new Error("Tauri bridge allowlist not found");
const allowedMethods = new Set([...allowedBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
const missing = [...frontendMethods].filter((method) => !allowedMethods.has(method)).sort();
if (missing.length > 0) throw new Error(`Tauri bridge allowlist is missing: ${missing.join(", ")}`);

console.log(`Tauri bridge allowlist verified (${frontendMethods.size} frontend methods)`);
