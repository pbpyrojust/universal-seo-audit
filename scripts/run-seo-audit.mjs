
import fs from "fs";
import path from "path";
import { runLighthouseAudit } from "./lib/lighthouse-runner.mjs";
import { checkAsset } from "./lib/asset-checker.mjs";

const args = process.argv.slice(2);
const siteIndex = args.indexOf("--site");
const runLighthouse = args.includes("--lighthouse");

if (siteIndex === -1) {
  console.error("Missing --site");
  process.exit(1);
}

const site = args[siteIndex + 1];
const outDir = path.resolve("reports/" + new URL(site).hostname + "-" + Date.now());
fs.mkdirSync(outDir, { recursive: true });

let lighthouseRows = [];
let assetRows = [];

console.log("Scanning:", site);

// basic test assets
const testAssets = [
  site + "/favicon.ico",
  site + "/robots.txt"
];

for (const asset of testAssets) {
  const result = await checkAsset(asset);
  assetRows.push(result);
}

if (runLighthouse) {
  const lh = await runLighthouseAudit(site);
  lighthouseRows.push(lh);
}

fs.writeFileSync(outDir + "/seo-assets.csv",
  "url,status,final_url,ok\n" +
  assetRows.map(r => `${r.url},${r.status},${r.final_url || ""},${r.ok}`).join("\n")
);

if (runLighthouse) {
  fs.writeFileSync(outDir + "/seo-lighthouse.csv",
    "url,performance,lcp,cls,tbt\n" +
    lighthouseRows.map(r => `${r.url},${r.performance},${r.lcp},${r.cls},${r.tbt}`).join("\n")
  );
}

console.log("Done:", outDir);
