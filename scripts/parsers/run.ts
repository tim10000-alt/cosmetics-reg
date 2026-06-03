import { loadEnv } from "../crawlers/env";
loadEnv();

import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractWithModel } from "./extractor";
import { consensusCheck } from "./consensus";
import { applyOutcomes, type RegulationRow, type QuarantineRow } from "./upsert";
import type { IngredientLite } from "./ingredients";
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { GEMINI_PRIMARY, GEMINI_SECONDARY } from "../gemini-models";

// Phase 5b — Supabase 제거. source-status.json 에서 ok/unchanged 행 순회 → .crawl-raw 파싱
// → ingredients/regulations/quarantine in-memory 작업본 mutate → 마지막 한 번 write.

const RAW_DIR = ".crawl-raw";
const PRIMARY_MODEL = GEMINI_PRIMARY;
const SECONDARY_MODEL = GEMINI_SECONDARY;

interface SourceStatusRow {
  country_code: string;
  doc_key: string;
  title: string;
  source_url: string;
  content_hash: string | null;
  check_status: string | null;
  last_parsed_hash: string | null;
  last_parsed_at: string | null;
  regulation_source_id: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const filter = args.find((a) => !a.startsWith("--"))?.toUpperCase();

  const allStatus = await readRows<SourceStatusRow>("source-status");
  let docs = allStatus.filter(
    (d) => (d.check_status === "ok" || d.check_status === "unchanged") && d.content_hash,
  );
  if (filter) docs = docs.filter((d) => d.country_code === filter);

  if (docs.length === 0) {
    console.log("파싱할 문서가 없습니다 (source-status.json 에 ok/unchanged 행 없음).");
    return;
  }

  // 무료 티어 throttle: 미파싱(변경) 문서만, 런당 상한 만큼만 처리 → 다음 런에서 이어감.
  // parse 가 느려져 30분 타임아웃 전에 write 못 하고 진행분이 소실되는 것을 방지.
  const pending = docs.filter(
    (d) => force || !(d.last_parsed_hash && d.last_parsed_hash === d.content_hash),
  );
  // --force(수동 전체 재파싱)는 상한 무시 — 누락 0. 일일 cron(비-force)만 상한 적용해
  // 무료 throttle 로 느려진 parse 가 타임아웃 전 진행분을 잃지 않게 함.
  const MAX_DOCS_PER_RUN = Number(process.env.PARSE_MAX_DOCS ?? 12);
  const batch = force ? pending : pending.slice(0, MAX_DOCS_PER_RUN);
  if (pending.length > batch.length) {
    console.log(
      `ℹ️ 미파싱 ${pending.length}건 중 ${batch.length}건만 이번 런 처리(무료 throttle) — 나머지 ${pending.length - batch.length}건은 다음 런에서 자동 이어감(누락 아님·연기).`,
    );
  }

  // Load + index in-memory
  const ingredients = await readRows<IngredientLite>("ingredients");
  const regulations = await readRows<RegulationRow>("regulations");
  const quarantine = await readRows<QuarantineRow>("quarantine");

  const byInciLower = new Map<string, IngredientLite>();
  const byCas = new Map<string, IngredientLite>();
  for (const i of ingredients) {
    byInciLower.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) {
      for (const cas of i.cas_no.split(/\s+/)) if (cas.trim()) byCas.set(cas.trim(), i);
    }
  }

  let dirty = false;

  for (const doc of batch) {
    if (!force && doc.last_parsed_hash && doc.last_parsed_hash === doc.content_hash) {
      console.log(`⊘ [${doc.country_code}] ${doc.doc_key} — already parsed (use --force)`);
      continue;
    }

    const base = `${doc.country_code}_${doc.doc_key}`;
    const candidates = [".html", ".pdf", ".csv", ".json", ".bin"].map((ext) => join(RAW_DIR, `${base}${ext}`));
    const filePath = candidates.find((p) => existsSync(p));
    if (!filePath) {
      console.log(`⊘ [${doc.country_code}] ${doc.doc_key} — no raw file in ${RAW_DIR}/`);
      continue;
    }

    console.log(`▶ [${doc.country_code}] ${doc.doc_key} (${filePath})`);
    try {
      // 무료 티어 보호: 두 모델을 동시(Promise.all)가 아니라 순차 호출 — 순간 TPM 절반.
      const primaryResults = await extractWithModel({ model: PRIMARY_MODEL, filePath, country: doc.country_code, title: doc.title, url: doc.source_url });
      const secondaryResults = await extractWithModel({ model: SECONDARY_MODEL, filePath, country: doc.country_code, title: doc.title, url: doc.source_url });
      console.log(`  ${PRIMARY_MODEL}: ${primaryResults.length}, ${SECONDARY_MODEL}: ${secondaryResults.length}`);

      const outcomes = consensusCheck(primaryResults, secondaryResults);
      const stats = applyOutcomes(
        {
          country_code: doc.country_code,
          source_url: doc.source_url,
          source_document: doc.title,
          source_document_id: doc.regulation_source_id ?? "unknown",
          ingredients,
          byInciLower,
          byCas,
          regulations,
          quarantine,
        },
        outcomes,
      );
      console.log(`  → ${JSON.stringify(stats)}`);
      dirty = true;

      // mark parsed
      const idx = allStatus.findIndex((s) => s.country_code === doc.country_code && s.doc_key === doc.doc_key);
      if (idx >= 0) {
        allStatus[idx].last_parsed_hash = doc.content_hash;
        allStatus[idx].last_parsed_at = new Date().toISOString();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ parse failed: ${msg}`);
    }
  }

  if (dirty) {
    await writeRows("ingredients", ingredients);
    await writeRows("regulations", regulations);
    await writeRows("quarantine", quarantine);
    await writeRows("source-status", allStatus);
    await updateMeta({
      ingredients: ingredients.length,
      regulations: regulations.length,
      quarantine_pending: quarantine.filter((q) => q.status === "pending").length,
    });
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
