import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strKey } from "../lib/strhash";
const DATA = join(__dirname, "..", "public", "data");
const cache: Record<string, string> = JSON.parse(readFileSync(join(DATA, "translations.json"), "utf8")).translations ?? {};
const seen = new Set<string>();
const pairs: { ko: string; orig: string; cc: string; field: string }[] = [];
for (const f of readdirSync(join(DATA, "regulations")).filter((x) => x.endsWith(".json"))) {
  const cc = f.slice(0, -5);
  for (const r of JSON.parse(readFileSync(join(DATA, "regulations", f), "utf8")).rows as Record<string, unknown>[]) {
    for (const field of ["conditions", "source_document", "override_note"]) {
      const v = r[field];
      if (typeof v !== "string" || !v) continue;
      const k = strKey(v);
      if (cache[k] && !seen.has(k)) { seen.add(k); pairs.push({ ko: cache[k], orig: v, cc, field }); }
    }
    const pc = r["product_categories"];
    if (Array.isArray(pc)) for (const v of pc) {
      if (typeof v !== "string" || !v) continue;
      const k = strKey(v);
      if (cache[k] && !seen.has(k)) { seen.add(k); pairs.push({ ko: cache[k], orig: v, cc, field: "product_categories" }); }
    }
  }
}
writeFileSync(join(__dirname, "..", "_pairs.json"), JSON.stringify(pairs, null, 1));
console.log("추출 쌍:", pairs.length, "/ 캐시", Object.keys(cache).length);
