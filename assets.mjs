import { readFileSync, writeFileSync, readdirSync } from "node:fs";
for (const f of readdirSync("assets")) { if (!f.endsWith(".b64")) continue;
  writeFileSync("public/" + f.slice(0, -4), Buffer.from(readFileSync("assets/" + f, "utf8").trim(), "base64")); }
const site = (process.env.URL || "").replace(/\/$/, "");
for (const page of ["public/index.html", "public/club/index.html"])
  writeFileSync(page, readFileSync(page, "utf8").split("%SITE_URL%").join(site));
