// Gemini 모델명 단일 출처(single source of truth).
// Google 이 모델을 폐기/개명하면 — 여기 기본값 한 줄, 또는 env(코드 배포 없이)만
// 바꾸면 모든 인입 스크립트(run/kcia-attach/enrich)가 따라감.
// (이전엔 4곳에 하드코딩돼 폐기 시 누락 위험이 있었음.)
export const GEMINI_PRIMARY = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const GEMINI_SECONDARY = process.env.GEMINI_MODEL_SECONDARY ?? "gemini-2.5-flash-lite";
