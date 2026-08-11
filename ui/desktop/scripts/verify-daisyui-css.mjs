import { readdir, readFile } from "node:fs/promises";

const assetsDir = new URL("../dist/assets/", import.meta.url);
const files = (await readdir(assetsDir)).filter((file) => file.endsWith(".css"));
const css = (await Promise.all(files.map((file) => readFile(new URL(file, assetsDir), "utf8")))).join("\n");

for (const selector of [".btn{", ".input{", ".card{", ".modal{"]) {
  if (!css.includes(selector)) throw new Error(`daisyUI selector missing from build: ${selector}`);
}
for (const directive of ["@plugin", "@tailwind", "@theme"]) {
  if (css.includes(directive)) throw new Error(`unprocessed Tailwind directive in build: ${directive}`);
}

console.log("daisyUI CSS verified");
