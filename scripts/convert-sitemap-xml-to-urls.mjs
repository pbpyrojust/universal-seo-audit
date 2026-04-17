#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace(/^--/, "");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.input || !args.out) {
  console.error("Usage: node scripts/convert-sitemap-xml-to-urls.mjs --input ./saved-sitemap.xml --out ./urls.txt");
  process.exit(1);
}
const xml = fs.readFileSync(path.resolve(process.cwd(), args.input), "utf8");
const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/gsi)].map((m) => m[1].trim());
fs.writeFileSync(path.resolve(process.cwd(), args.out), [...new Set(urls)].join("\n") + "\n", "utf8");
console.log(`Wrote: ${path.resolve(process.cwd(), args.out)}`);
