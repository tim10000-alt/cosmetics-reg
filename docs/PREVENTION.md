# 오표기·버그 예방 아키텍처 (전자동·무Gemini 기본 + Gemini 보강)

자기일관성 감사(UI vs 데이터)만으로는 **데이터-진실 오류**와 **변경의 부작용**을 못 잡는다
(오라클이 같은 데이터에서 나오므로). 그래서 서로 다른 축을 보는 **다층 방어(defense-in-depth)**를
둔다. 알려진 버그는 결정론 게이트로 영구 차단하고, **미지의 미래 버그는 차분 + Gemini 재판정**으로
포착한다. 모든 계층은 crawl/스케줄 CI에서 전자동 실행.

## 검증의 4축 (왜 한 가지로는 부족한가)
1. **표시 충실성**(UI==데이터): deep-compare/banned-audit. 렌더 정확성만. *데이터 진실 못 봄.*
2. **구조 완전성**(데이터 내부 규칙): 한도 ≤100·>0, override 반영, 분절 충돌. 결정론.
3. **데이터==실제 법령**(ground-truth): 원문 PDF/xlsx 직접 대조 + Gemini 전 셀 감사. *핵심 축.*
4. **차분**(변경 전/후): 의도외 변화=부작용. *미지 버그·side-effect 포착의 핵심.*

## 상설 게이트 (crawl.yml, 전부 결정론·무Gemini·매 run)
- `apply-overrides.cjs` — 원문대조 교정(limit-overrides.json)을 prio110 으로 영속 재적용.
  banned 는 동일 CAS 전 변종(byCasAny), 한도교정은 주(첫) CAS 만(byCas, 복합 "및 그 염류"
  over-restriction 방지). **교정이 Gemini 없이 매일 영구 지속 = 재발 원천 차단.**
- `verify-kr-gosi.cjs --strict` — KR 고시 별표1 금지16 + 별표2 한도89 = 105종 레퍼런스 박제.
  MFDS 재인입이 한도/금지 누락 시 회귀 검출.
- `verify-overrides.cjs --strict` — 모든 override 가 실제 헤드라인에 반영되는지(분절·상위prio
  오행·CAS변형으로 무력화 검출). apply-overrides 와 동일 해석.
- `detect-status-conflicts.cjs --write` — 같은 CAS 분절 카드 banned↔허용 충돌(false-banned/
  allowed 씨앗) review-queue + 급증 경보. 카테고리/조건부/색소 제외.
- `headline-snapshot.cjs --diff --flips` + `--write` — **전 셀(86K) 차분.** 전 성분×국가 헤드라인
  스냅샷을 직전 baseline 과 비교, status-flip 로그 후 갱신. **어떤 원인(파서/소스/병합)이든
  의도외 대량 flip 을 포착 = 미지 버그 조기경보.**
- 기존: cas-contamination-audit · cross-source-consistency · audit-limit-completeness ·
  data-quality-check · quality-guardian(불가능농도 제거·오염명 격리).

## Gemini 전 셀 ground-truth 감사 (audit-cells.yml, 무료·장기 전자동)
- `audit-cells-gemini.ts` — 전 86K 셀을 무료 Gemini 듀얼모델 합의로 각국 실제 규제와 대조 →
  false-allowed/false-banned/wrong-limit 색출 → `audit-findings.json`(검토큐).
- **자동수정 안 함**(LLM 단독 규제뒤집기 = 규제사고). 사람이 원문확인 후 limit-overrides 로 교정
  → 그러면 결정론 게이트가 영구 보장.
- 멱등 캐시(셀 hash)·배치상한·quota circuit-breaker → 며칠에 걸쳐 전 셀 점진 커버, **변경 셀만
  재판정.** Gemini 다운/쿼터소진에도 누적 진행(장기 전자동).

## 미지의 미래 버그 대비 (핵심 원리)
- **차분(축4)**: 새 코드/소스/병합이 무엇을 바꾸든, 의도하지 않은 셀 변화는 snapshot diff 가 전부
  표면화. 버그의 *종류를 몰라도* "안 바뀌어야 할 게 바뀜"으로 잡힌다.
- **Gemini 재판정(축3)**: 셀 내용이 바뀌면 hash 가 바뀌어 재감사 대상이 됨 → 새로 들어온 잘못된
  데이터가 자동으로 ground-truth 검증을 다시 받음.
- **review-queue 급증 경보**: status-conflicts·flips·cas-contamination 의 baseline 대비 급증 =
  신규 결함/파서 regression 조기 신호.
- **비대칭 안전**: 불확실하면 교정 안 함(오표기 방지) + 자동수정 금지(검토큐). false-allowed 와
  오표기를 동급 제약으로 둔다.

## 새 버그 발견 시 절차 (재발방지 표준)
1. 원문(PDF/xlsx)으로 진실 확인(기억 아님). 2. limit-overrides.json 에 교정 추가(durable).
3. 해당 클래스를 잡는 게이트 추가/확장(verify-* 또는 detect-*). 4. snapshot baseline 갱신.
5. CI 라이브로 게이트 green·교정 헤드라인 반영 실증.
