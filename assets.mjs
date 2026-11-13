// Build step: turns the base64 images in assets/ into real files in public/,
// and fills in the site address used by link previews.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

for (const f of readdirSync("assets")) {
  if (!f.endsWith(".b64")) continue;
  writeFileSync("public/" + f.slice(0, -4), Buffer.from(readFileSync("assets/" + f, "utf8").trim(), "base64"));
  console.log("wrote public/" + f.slice(0, -4));
}
const site = (process.env.URL || "").replace(/\/$/, "");
const page = "public/index.html";
writeFileSync(page, readFileSync(page, "utf8").split("%SITE_URL%").join(site));
console.log("site address for previews:", site || "(none)");
