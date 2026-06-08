import { randomUUID } from "node:crypto";
import type { ExtractedRegulation } from "./schema";
import { findOrCreateIngredient, type IngredientLite } from "./ingredients";
import { isOutlier, type ConsensusOutcome } from "./consensus";

// Phase 5b — Supabase 제거. 호출자가 미리 ingredients/regulations/quarantine 의
// in-memory 작업본 + 인덱스를 넘기고, applyOutcomes 가 mutate 후 caller 가 write.

export interface UpsertContext {
  country_code: string;
  source_url: string;
  source_document: string;
  source_document_id: string;
  ingredients: IngredientLite[];
  byInciLower: Map<string, IngredientLite>;
  byCas: Map<string, IngredientLite>;
  regulations: RegulationRow[];
  quarantine: QuarantineRow[];
}

export interface RegulationRow {
  ingredient_id: string;
  country_code: string;
  status: string;
  max_concentration: number | null;
  concentration_unit: string | null;
  product_categories: string[];
  conditions: string | null;
  source_url: string | null;
  source_document: string;
  source_version: string | null;
  last_verified_at: string;
  confidence_score: number;
  override_note: string | null;
}

export interface QuarantineRow {
  id: string;
  ingredient_name_raw: string;
  country_code: string;
  proposed_data: ExtractedRegulation;
  confidence_score: number;
  flash_result: ExtractedRegulation | null;
  pro_result: ExtractedRegulation | null;
  rejection_reason: string;
  source_document_id: string;
  status: "pending" | "approved" | "rejected";
}

export interface UpsertStats {
  inserted: number;
  updated: number;
  quarantined: number;
  skipped: number;
}

export function applyOutcomes(ctx: UpsertContext, outcomes: ConsensusOutcome[]): UpsertStats {
  const stats: UpsertStats = { inserted: 0, updated: 0, quarantined: 0, skipped: 0 };

  for (const outcome of outcomes) {
    if (outcome.kind === "disagreed") {
      findOrCreateIngredient(ctx.ingredients, ctx.byInciLower, ctx.byCas, outcome.flash);
      addQuarantine(ctx, {
        raw_name: outcome.flash.inci_name,
        proposed: outcome.flash,
        flash: outcome.flash,
        pro: outcome.pro,
        reason: `model_disagreement: ${outcome.reason}`,
        confidence: 0.5,
      });
      stats.quarantined++;
      continue;
    }

    if (outcome.kind === "flash_only" || outcome.kind === "pro_only") {
      const reg = outcome.kind === "flash_only" ? outcome.flash : outcome.pro;
      findOrCreateIngredient(ctx.ingredients, ctx.byInciLower, ctx.byCas, reg);
      addQuarantine(ctx, {
        raw_name: reg.inci_name,
        proposed: reg,
        flash: outcome.kind === "flash_only" ? reg : null,
        pro: outcome.kind === "pro_only" ? reg : null,
        reason: `one_model_only_${outcome.kind}`,
        confidence: 0.3,
      });
      stats.quarantined++;
      continue;
    }

    const reg = outcome.merged;
    const ingredient_id = findOrCreateIngredient(ctx.ingredients, ctx.byInciLower, ctx.byCas, reg);

    // (성분, 국가) 단위 dedup — 파서(Gemini) 경로. 용도-변종 보존은 fetcher 경로(각국 직접 write)와
    // display 층(all_sources 전부 표기)이 담당. 파서 경로에서 use-signature 분리를 시도했으나, 조건
    // 텍스트 키는 버전갱신 시 near-dup 누적, 제품군+출처 키는 빈-제품군 조건변종 collapse 라는 tradeoff
    // 가 있고 파서 경로 손실은 측정상 0(outlier-quarantine 0)이라, 위험 회피 위해 원래 단순 dedup 유지.
    const existing = ctx.regulations.find(
      (r) => r.ingredient_id === ingredient_id && r.country_code === ctx.country_code,
    );

    if (existing) {
      const out = isOutlier(reg.max_concentration, existing.max_concentration);
      if (out.outlier) {
        addQuarantine(ctx, {
          raw_name: reg.inci_name,
          proposed: reg,
          flash: reg,
          pro: reg,
          reason: `outlier_concentration: ${out.reason}`,
          confidence: outcome.confidence,
        });
        stats.quarantined++;
        continue;
      }
    }

    const row: RegulationRow = {
      ingredient_id,
      country_code: ctx.country_code,
      status: reg.status,
      max_concentration: reg.max_concentration,
      concentration_unit: reg.concentration_unit,
      product_categories: reg.product_categories,
      conditions: reg.conditions,
      source_url: ctx.source_url,
      source_document: ctx.source_document,
      source_version: null,
      last_verified_at: new Date().toISOString(),
      confidence_score: outcome.confidence,
      override_note: null,
    };

    if (existing) {
      Object.assign(existing, row);
      stats.updated++;
    } else {
      ctx.regulations.push(row);
      stats.inserted++;
    }
  }

  return stats;
}

function addQuarantine(
  ctx: UpsertContext,
  q: {
    raw_name: string;
    proposed: ExtractedRegulation;
    flash: ExtractedRegulation | null;
    pro: ExtractedRegulation | null;
    reason: string;
    confidence: number;
  },
) {
  ctx.quarantine.push({
    id: randomUUID(),
    ingredient_name_raw: q.raw_name,
    country_code: ctx.country_code,
    proposed_data: q.proposed,
    confidence_score: q.confidence,
    flash_result: q.flash,
    pro_result: q.pro,
    rejection_reason: q.reason,
    source_document_id: ctx.source_document_id,
    status: "pending",
  });
}
