import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { translateDisplay } from "../lib/translate-display";

// 전수 번역 완성도 감사 — 모든 regulations 행의 표시 필드(conditions·source_document)에
// 실제 표시층 translateDisplay(Gemini 캐시 + 결정론 seed)를 적용한 *뒤* 남는 외국어를
// 국가별로 정확히 집계. 표본 아님 = 전 행 대상.
const DATA = join(__dirname, "..", "public", "data");
const REG = join(DATA, "regulations");

const FOREIGN = /[㐀-鿿぀-ヿ฀-๿Ѐ-ӿ]/;
const FOREIGN_G = /[㐀-鿿぀-ヿ฀-๿Ѐ-ӿ]/g;
const BILINGUAL = /중문\s*(명칭|명)?\s*[:：]/;   // CN 의도적 이중표기(한국어 완비+원문 참조)

const cache = new Map<string, string>();
try {
  const tj = JSON.parse(readFileSync(join(DATA, "translations.json"), "utf8")).translations ?? {};
  for (const k of Object.keys(tj)) cache.set(k, tj[k]);
} catch { /* 없으면 빈 캐시 */ }

type Stat = { rows: number; condForeign: number; condBilingual: number; condRemaining: number; srcForeign: number; srcRemaining: number };
const per: Record<string, Stat> = {};
const worstSamples: { cc: string; field: string; text: string }[] = [];

for (const f of readdirSync(REG).filter((x) => x.endsWith(".json"))) {
  const cc = f.slice(0, -5);
  const rows = JSON.parse(readFileSync(join(REG, f), "utf8")).rows as Record<string, unknown>[];
  const s: Stat = { rows: rows.length, condForeign: 0, condBilingual: 0, condRemaining: 0, srcForeign: 0, srcRemaining: 0 };
  for (const r of rows) {
    const c = r.conditions;
    if (typeof c === "string" && FOREIGN.test(c)) {
      s.condForeign++;
      if (BILINGUAL.test(c)) s.condBilingual++;
      else {
        const t = translateDisplay(c, cache);
        const left = (t.match(FOREIGN_G) || []).length;
        if (left > 2) {
          s.condRemaining++;
          if (worstSamples.length < 8) worstSamples.push({ cc, field: "conditions", text: t.replace(/\s+/g, " ").slice(0, 100) });
        }
      }
    }
    const sd = r.source_document;
    if (typeof sd === "string" && FOREIGN.test(sd)) {
      s.srcForeign++;
      const t = translateDisplay(sd, cache);
      if ((t.match(FOREIGN_G) || []).length > 2) s.srcRemaining++;
    }
  }
  per[cc] = s;
}

console.log("국가 | 행 | 조건外 | (CN이중) | 조건잔존 | 출처外 | 출처잔존");
const R = { cond: 0, src: 0, bil: 0 };
for (const [cc, s] of Object.entries(per).sort((a, b) => b[1].condRemaining - a[1].condRemaining)) {
  if (s.condForeign || s.srcForeign)
    console.log(`${cc} | ${s.rows} | ${s.condForeign} | ${s.condBilingual} | ${s.condRemaining} | ${s.srcForeign} | ${s.srcRemaining}`);
  R.cond += s.condRemaining; R.src += s.srcRemaining; R.bil += s.condBilingual;
}
console.log(`\n전수 합계: 조건문 잔존(번역 후 외국어>2) = ${R.cond} · 출처 잔존 = ${R.src} · CN 이중표기(의도적 제외) = ${R.bil}`);
console.log("\n조건 잔존 샘플:");
for (const w of worstSamples) console.log(`  [${w.cc}] ${w.text}`);
