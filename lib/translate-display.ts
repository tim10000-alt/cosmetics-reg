// 표시층 한글화 — 일부 국가는 출처 문서명/조건문이 원문(대만 TFDA 번체·중국 NMPA·일본 MHLW
// 한자)으로 들어온다. 데이터(저장값)는 불변, *표시 시점*에만 한글로 치환한다.
// 결정론·가역·exact-match(부분 오역 위험 0)·일일 refresh 무관(매 조회 시 적용 → 새 데이터도 자동 한글).
//
// 키는 데이터에 실제로 존재하는 정확한 원문 문자열. 전수 스캔 결과 영향 필드(source_document·
// conditions)의 비-한글 원문은 아래 고정 집합으로 한정됨(대만 7·중국 1·일본 2).
// 새로운 원문이 생기면 여기에 한 줄 추가하면 된다(검출: 비ASCII·비한글 잔존 감사).

const MAP: Record<string, string> = {
  // ── 영어전용 조건문(전수 감사로 발견 — 한글0·영어만) 한글화 ──
  "For case review, the applicant should submit relevant documents or information, including the qualifications of the exosome donor, preparation processes and inspection reports, stability tests, safety tests, as well as absorption, distribution, metabolism, and excretion tests.":
    "심사를 위해 신청자는 엑소좀 공여자의 자격, 제조 공정 및 검사 보고서, 안정성 시험, 안전성 시험, 그리고 흡수·분포·대사·배설 시험을 포함한 관련 서류 또는 정보를 제출해야 한다.",
  "The use of chloroform in cosmetic products is prohibited because it causes cancer in animals and is likely to be harmful to human health, too. The regulation makes an exception for residual amounts from its use as a processing solvent during manufacture, or as a byproduct from the synthesis of an ingredient":
    "클로로폼은 동물에서 암을 유발하고 인체 건강에도 유해할 가능성이 있어 화장품에 사용이 금지된다. 다만 제조 중 가공 용제로 사용되어 잔류하는 양, 또는 성분 합성 과정의 부산물로서 존재하는 양은 예외로 한다.",
  // ── 대만 TFDA 출처 표 이름 (化粧品禁限用成分管理規定 = 화장품 사용금지·제한 성분 관리규정) ──
  "TFDA 化粧品禁限用成分管理規定 — 化粧品禁止使用成分表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 사용금지 성분표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品防腐劑成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 보존제 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品色素成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 색소 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品防曬劑成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 자외선차단제 성분 사용제한표",
  // ── 대만 TFDA 조건문 ──
  "不得使用於染髮用途化粧品": "염모(헤어 염색)용 화장품에는 사용할 수 없음",
  "用 作 色 素 之 zirconium lakes, salts, pigments 及化粧品成分使用限制表中另有規定者除外。":
    "색소로 사용되는 지르코늄(zirconium) 레이크·염·안료, 및 화장품 성분 사용제한표에 별도 규정이 있는 경우는 제외.",
  // ── 중국 NMPA 출처 ──
  "NMPA IECIC (已使用化妆品原料目录)": "NMPA IECIC (사용된 화장품 원료 목록)",
  // ── 등록 원료 목록(registry_name) 표 이름 ──
  "TFDA 化粧品禁限用成分管理規定": "TFDA 화장품 사용금지·제한 성분 관리규정",
  "NMPA 已使用化妆品原料目录 (IECIC)": "NMPA 사용된 화장품 원료 목록 (IECIC)",
  "PMDA 標準成分 검색": "PMDA 표준성분 검색",
  // ── 일본 MHLW 출처 (化粧品基準 = 화장품기준) ──
  "JP MHLW 化粧品基準 (Standards for Cosmetics, Notification 331)":
    "JP MHLW 화장품기준 (Standards for Cosmetics, 고시 제331호)",
  "JP MHLW 化粧品基準 別表 1 (品目ごと承認対象成分 positive list)":
    "JP MHLW 화장품기준 별표1 (품목별 승인대상 성분 positive list)",
  // ── JP 1차 소스 PDF 제목(原 정부문서명) ──
  "化粧品基準 (Standards for Cosmetics) — 平成12年厚生省告示第331号":
    "화장품기준 (Standards for Cosmetics) — 헤이세이12년 후생성고시 제331호",
  "化粧品基準 別表 1 — 品目ごと承認対象成分 (Schedule 1: Approval-required ingredients per category)":
    "화장품기준 별표1 — 품목별 승인대상 성분 (Schedule 1: Approval-required ingredients per category)",
};

// 공백 변형(연속/엣지 공백)에도 매칭되도록 정규화 키 인덱스도 둔다.
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const NORM_MAP: Record<string, string> = {};
for (const [k, v] of Object.entries(MAP)) NORM_MAP[norm(k)] = v;

// ── 구절(부분문자열) 치환 — 조건문은 한도 숫자가 박혀 매번 유니크라 전체-문자열 캐시/MAP 가 미스되어
// 박힌 외국어 boilerplate(JP 한자·TW 번체)가 원문 그대로 노출되던 문제(전수 5,578건). 반복되는
// 규제 boilerplate를 정확한 한국어로 치환한다. 긴 구절을 먼저(부분겹침 방지). CJK 포함 시에만 적용.
const PHRASE: [string, string][] = [
  // ── TW 규제 boilerplate(전체 번체 문장) ──
  ["染髮、脫色、脫染及燙髮產品之應刊載之注意事項，應依衛生福利部公告刊載之", "염모·탈색·탈염 및 퍼머넌트 제품에 기재할 주의사항은 위생복리부 공고에 따라 기재해야 함"],
  ["染髮產品之限量標準：係指該成分依產品使用說明書混合後之最高允許使用量", "염모 제품 한도 기준: 해당 성분을 제품 사용설명서대로 혼합한 후의 최고 허용 사용량"],
  ["化粧品之外包裝或容器，應明顯標示本表所列成分之注意事項", "화장품 외포장·용기에 본 표에 열거된 성분의 주의사항을 명확히 표시해야 함"],
  ["因外包裝或容器表面積過小或其他特殊情形致不能標示者，應於標籤、仿單或以其他方式刊載之", "외포장·용기 표면적이 너무 작거나 기타 특수사정으로 표시할 수 없는 경우 라벨·설명서 또는 기타 방식으로 기재"],
  ["化粧品宣稱效能者，須符合化粧品標示宣傳廣告涉及虛偽誇大或醫療效能認定準則規定", "화장품 효능을 표방하는 경우 「화장품 표시·광고의 허위·과대 또는 의료효능 인정기준」 규정을 준수해야 함"],
  ["本表所稱之口腔製劑，包含非藥用牙膏、漱口水類及美白牙齒類等化粧品", "본 표의 구강제제는 비의약용 치약·구강청결제류 및 치아미백류 등 화장품을 포함"],
  ["未列載於此表規定範圍之成分，於歐盟、美國及日本三國家地區，任何其中一個國家地區官方已公告（以生效日為準）其使用基準者，得參照其基準規定准予使用(但下表CI 11380 等十九項成分不適用)", "본 표 범위에 없는 성분이라도 EU·미국·일본 중 한 곳의 공식기관이 사용기준을 공고(시행일 기준)한 경우 그 기준을 참조해 사용 허용(단 아래 표 CI 11380 등 19개 성분은 제외)"],
  ["所列色素與非禁用成分形成之麗基（lakes）及鹽（salts）亦可使用", "열거된 색소와 비금지 성분으로 형성된 레이크(lakes)·염(salts)도 사용 가능"],
  ["若以其他途徑攝取氟化物者，應諮詢牙醫師或醫師", "다른 경로로 불소를 섭취하는 경우 치과의사 또는 의사와 상담할 것"],
  ["可能使用於 2 歲以下孩童之產品（立即沖洗產品得免刊載該注意事項）： 2歲以下孩童使用前請諮詢醫師或藥師", "만 2세 이하 아동 제품에 사용될 수 있음(즉시 씻어내는 제품은 해당 주의사항 면제): 만 2세 이하 아동 사용 전 의사·약사와 상담"],
  ["染髮、燙髮產品", "염모·퍼머넌트 제품"],
  ["不得使用於染髮用途化粧品", "염모(헤어 염색)용 화장품에는 사용할 수 없음"],
  // ── JP 화장품기준 용어/각주 ──
  ["（注1）空欄は、配合してはならないことを示し、○印は、配合の上限がないことを示す", "(주1) 공란은 배합 불가를, ○표는 배합 상한이 없음을 의미"],
  ["「＊」は旧基準に収載されていた成分", "「＊」는 구 기준에 수재되었던 성분"],
  ["旧基準に収載されていた成分", "구 기준에 수재되었던 성분"],
  ["石けん,シャンプー等の直ちに洗い流す化粧品以外の化粧品", "비누·샴푸 등 즉시 씻어내는 화장품 이외의 화장품"],
  ["石けん,シャンプー等の直ちに洗い流す化粧品", "비누·샴푸 등 즉시 씻어내는 화장품"],
  ["種別配合成分規格", "종별 배합성분 규격"],
  ["承認対象成分", "승인대상 성분"],
  ["化粧品基準", "화장품기준"],
  ["合計量として", "합계량으로"],
  ["厚生省", "후생성"],
  ["告示", "고시"],
  ["別表", "별표"],
  ["清浄用", "세정용"], ["頭髪用", "두발용"], ["メークアップ", "메이크업"],
  ["芳香", "방향"], ["日焼け", "선탠"], ["基礎", "기초"],
  // ── 공통 단위/문구 ──
  ["以重量計", "중량 기준"],
  // ── 안전한 단독/라벨 용어(주위가 한글/영문이라 치환해도 salad 안 됨) ──
  // ⚠ 문장 *중간* 원자치환(染髮·成分·之 등)은 한-중 word salad 를 만들어 금지. raw 중국어 문장은
  //   전체-구절 매칭 또는 Gemini whole-string 번역(translations.json)으로만 처리(자연스러운 한글).
  ["項次", "항목"], ["備註", "비고"],
  ["品目ごと", "품목별"], ["医薬部外品", "의약외품"],
  // 한도 라벨/짧은 표준어구(값 옆 단독어 — salad 위험 낮음)
  ["所有化粧品均可使用", "모든 화장품에 사용 가능"], ["限用於用後立即洗去之化粧品", "사용 후 즉시 씻어내는 화장품에 한함"],
  ["氧化性", "산화성"], ["非氧化性", "비산화성"], ["限量", "한도"], ["含釋出", "방출되는"],
  ["禁止使用", "사용 금지"], ["得使用", "사용 가능"],
  // ── TW 잔여 번체 단편(명확한 복합어 경계 — word-salad 위험 낮음). 대부분 한글 번역이 옆에
  //   이미 있고 중문 원문만 남은 케이스 → 한글로 치환하면 중문 제거(사용자: 다른 언어 불가). ──
  ["染髮產品", "염모 제품"], ["染髮、燙髮", "염모·퍼머넌트"], ["燙髮產品", "퍼머넌트 제품"],
  ["限用於非接觸黏膜之化粧品", "점막 비접촉 화장품에 한함"],
  ["限用於非接觸眼部周圍之化粧品", "눈 주위 비접촉 화장품에 한함"],
  ["限用於用後立即洗去之化粧品", "사용 후 즉시 씻어내는 화장품에 한함"],
  ["可能引起失明", "실명을 유발할 수 있음"], ["含強鹼", "강염기 함유"],
  ["以acid 計", "산으로서 계산"], ["以 acid 計", "산으로서 계산"], ["以acid計", "산으로서 계산"],
  ["以free base 計", "유리 염기로서 계산"], ["以 free base 計", "유리 염기로서 계산"],
  ["以 free SO", "유리 SO"], ["以 sulfate 計", "황산염으로서 계산"], ["以單一", "단일"],
  ["以重量計", "중량 기준"], ["總量", "총량"], ["注", "주"], ["備註", "비고"],
  // 위 "未列載…" 문장 꼬리(별도 분절로 자주 잔존, 237회) — 검사등록 첨부 의무.
  ["，惟於申請查驗登記時，應同時檢附該等地區之准許使用基準證明文件。", ", 단 검사등록 신청 시 해당 지역의 허가 사용기준 증명문서를 함께 첨부해야 함."],
  ["惟於申請查驗登記時，應同時檢附該等地區之准許使用基準證明文件", "단 검사등록 신청 시 해당 지역의 허가 사용기준 증명문서를 함께 첨부해야 함"],
  ["化粧品防腐劑成分名稱及使用限制表中另有規定者除外", "화장품 보존제 성분 명칭 및 사용제한표에 별도 규정이 있는 경우는 제외"],
  ["化粧品成分使用限制表中另有規定者除外", "화장품 성분 사용제한표에 별도 규정이 있는 경우는 제외"],
  ["立即沖洗產品", "즉시 씻어내는 제품"], ["髮類產品", "두발용 제품"], ["香皂", "비누"],
  ["口腔製劑", "구강제제"], ["於噴霧類產品", "분무(스프레이)류 제품에서"], ["避免兒童接觸", "아동의 접촉을 피할 것"],
  ["使用前請先作皮膚敏感性測試", "사용 전 피부 감작성 테스트를 먼저 실시할 것"], ["皮膚敏感者", "피부 민감자"],
  // "以 X 計"(X=영문 화학명) — 양 끝이 명확한 다글자 구. 한글 번역이 옆에 병기된 경우 많아 중복돼도
  //   한글화 목적(중문 제거). 단일 글자(計·以·含 등)는 合計→salad 위험이라 제외(Gemini 파이프라인이 처리).
  ["以 tetrahydrochloride 計", "(테트라하이드로클로라이드로서 계산)"],
  ["以thioglycollic acid 計", "(치오글라이콜릭애씨드로서 계산)"], ["以 thioglycollic acid 計", "(치오글라이콜릭애씨드로서 계산)"],
  ["以 free SO2 計", "(유리 SO2로서 계산)"], ["以free SO2 計", "(유리 SO2로서 계산)"],
  // 안전 제거/치환 — 之(중국어 소유격 조사, 한국어엔 없음)는 삭제. JP 용어.
  ["之", ""], ["配合不可", "배합 불가"], ["国際単位", "국제단위"], ["力価", "역가"], ["油溶性", "유용성"],
  ["ショウキョウチンキ", "생강 팅크"], ["トウガラシチンキ", "고추 팅크"], ["歯磨", "치약"],
  // "以 X 計"(원소·화학명으로서 계산) 변형
  ["以 F 計", "(불소(F)로서 계산)"], ["以 zinc 計", "(아연으로서 계산)"],
  ["以 hydrochloride 計", "(염산염으로서 계산)"], ["以hydrochloride計", "(염산염으로서 계산)"],
  ["以 strontium 計", "(스트론튬으로서 계산)"], ["以 AgCl計", "(염화은(AgCl)으로서 계산)"],
  ["以 NH3 計", "(암모니아(NH3)로서 계산)"], ["以free base計", "(유리 염기로서 계산)"],
  ["以 free base計", "(유리 염기로서 계산)"], ["유리 SO2計", "(유리 SO2로서 계산)"], ["유리 SO2 計", "(유리 SO2로서 계산)"],
  ["以單一", "단일"], ["以단일", "단일"],
  // 含(함유)·除外(제외)·染髮產(염모 제품)·규정 단서. 含量(함량)은 따로(含 단독 치환이 깨지 않게).
  ["含量", "함량"], ["含 ", "함유: "], ["含Thioglycolate", "티오글라이콜레이트 함유"],
  ["含 thioglycolate", "티오글라이콜레이트 함유"], ["含 Resorcinol", "레조르시놀 함유"],
  ["含 strontium chloride", "염화스트론튬 함유"], ["含 Phenylmercuric compounds", "페닐수은 화합물 함유"],
  ["染髮產", "염모 제품"],
  ["另有規定者除外", "별도 규정이 있는 경우 제외"], ["除外", "제외"],
  // CN 성분명(번체/간체) — 영문 INCI 가 괄호에 병기됨
  ["半乳甘露聚糖", "갈락토만난"], ["黑参", "흑삼"], ["水解透明质酸锌", "가수분해 히알루론산 아연"],
  // TW α-하이드록시산 주의 — 중문 원문(뒤에 한국어 번역 병기됨) 제거
  ["α-Hydroxy acids 對皮膚容易引起刺激性，消費者使用時應주意下列事項：", "α-하이드록시산은 피부에 자극을 일으키기 쉬우므로 소비자 사용 시 다음 사항에 유의: "],
  ["皮膚有損傷、傷口或紅腫時不사용 가능。", ""], ["嬰兒及孩童不宜使用本產品。", ""],
  ["使用時皮膚如有異常現象，請暫停使用。", ""], ["本產品含 α-Hydroxy acids  成分，可能增加皮膚對陽光敏感及曬傷可能性。", ""],
  ["使用本產品後必須使用防曬劑、穿著有保護衣物及一個星期內應避免陽光曝曬。", ""],
  ["使用後皮膚如有持續紅腫或出現不適應症狀時，請立即就醫診治。", ""],
  ["特定用途", "특정 용도"],
  // 비고 원문·주의 연결 단편(중문 제거→한글)
  ["不得與亞硝基化劑一起使用", "니트로소화제와 함께 사용 금지"], ["亞硝胺", "니트로사민"], ["亞硝基化劑", "니트로소화제"],
  ["不得吞食", "삼키지 마십시오"], ["不得超過", "초과 금지"], ["安定劑不得超過", "안정제로서 다음을 초과 금지:"],
  ["安定劑", "안정제"], ["接觸黏膜部位產品", "점막 접촉 부위 제품"], ["接觸黏膜", "점막 접촉"],
  ["不사용 가능於", "다음에 사용 불가: "], ["使用於", "사용: "], ["用作", "다음 용도: "],
  ["牙齦或口腔若出現不適反應", "잇몸이나 구강에 불편한 반응이 나타나면"], ["如紅,腫,疼痛等", "(붉음, 부기, 통증 등)"],
  ["即時就醫", "즉시 진료"], ["請暫停使用", "사용을 중단하십시오"], ["部位產品", "부위 제품"],
  ["주意事項（즉시 씻어내는 제품得免刊載該주意事項）", "주의사항(즉시 씻어내는 제품은 해당 주의사항 면제)"],
  ["得免刊載該", "다음은 면제: "], ["주意事項", "주의사항"], ["不適應症狀", "부적응 증상"],
  // TW 잔여 명사·JP 각주 단편
  ["三歲以下孩童尿布部位", "3세 이하 아동 기저귀 부위"], ["三歲以下孩童", "3세 이하 아동"],
  ["尿布部位", "기저귀 부위"], ["洗髮產品", "샴푸 제품"], ["口腔及", "구강 및 "], ["口腔", "구강"],
  ["非즉시 씻어내는 제품", "즉시 씻어내지 않는 제품"], ["不宜使用本產品", "본 제품 사용에 부적합"],
  ["液を", "액을 "], ["末を", "분말을 "], ["この項の", "이 항목의 "], ["エステルとは", "에스테르란"],
  ["エステル", "에스테르"], ["ショウキョウニキス", "생강 추출물"], ["パラオキシン", "파라옥시"],
  ["皮膚有損傷、傷口或紅腫時不", "피부에 손상·상처·붉은 부기가 있을 때는 "],
  ["嬰兒及孩童不宜使用本產品", "영유아 및 아동은 본 제품 사용 부적합"],
  ["使用時皮膚如有異常現象", "사용 시 피부에 이상 증상이 있으면"],
  ["使用後皮膚如有持續紅腫或出現不適應症狀時，請立即就醫診治", "사용 후 피부에 지속적 붉은 부기나 부적응 증상이 나타나면 즉시 진료받으십시오"],
  ["對皮膚容易引起刺激性", "피부에 자극을 일으키기 쉬움"], ["消費者使用時應", "소비자 사용 시 "],
  ["下列事項", "다음 사항"], ["成分，可能增加皮膚對陽光敏感及曬傷可能性", " 성분, 피부의 햇빛 민감성 및 일광화상 가능성을 높일 수 있음"],
  ["且產品", "또한 제품"], ["以上", " 이상"], ["以下", " 이하"], ["作為", "...로서"],
  ["不사용 가능於", "다음에 사용 불가: "], ["不사용 가능", "사용 불가"], ["不得使用", "사용 금지"],
  ["相當於 silver", "은(silver) 상당량"], ["保護劑用途", "보존제 용도"], ["收斂劑用途", "수렴제 용도"],
  ["眼部製劑", "눈 부위 제제"], ["구강與눈 부위", "구강 및 눈 부위"],
  ["100g당 최대 배합량(Maximum amount of ingredient per 100 g)", "100g당 최대 배합량"],
  ["以 chlorhexidine計", "(클로르헥시딘으로서 계산)"], ["以 chlorhexidine 計", "(클로르헥시딘으로서 계산)"],
  // TW 비고 원문 잔여 — 세그먼트의 *정확한 복합어*만(긴 면책조항 부분문자열 包裝/容器/仿單/標籤 회피).
  // ⚠ 원문 중국어 형태로 등록(번역 후 한국어형은 PHRASE 1-pass 순서상 매칭 안 됨).
  ["禁止使用於", "다음에 사용 금지: "], ["禁用於", "다음에 사용 금지: "], ["不得使用於", "다음에 사용 불가: "],
  ["不得用於", "다음에 사용 불가: "], ["適用於", "다음에 적용: "], ["不得添加於", "다음에 첨가 금지: "],
  ["三歲以下孩童尿布部位", "3세 이하 아동 기저귀 부위"], ["三歲以下孩童", "3세 이하 아동"], ["尿布部位", "기저귀 부위"],
  ["意事項", "의사항"], ["本產品含", "본 제품 함유: "],
  ["二苯酮", "벤조페논"], ["不得超過", "초과 금지"], ["純度標準", "순도 기준"],
  ["屬奈米等級者", "나노 등급에 속하는 것"], ["指甲用產品", "손톱용 제품"],
  ["眼部產品", "눈 부위 제품"], ["唇部產品", "입술 부위 제품"], ["眼部製劑", "눈 부위 제제"],
  ["混合使用", "혼합 사용"], ["單獨使用", "단독 사용"], ["編號", "번호"], ["其鹽類", "그 염류"],
  ["添加", "첨가"], ["粒徑", "입경"], ["沐浴和", "목욕(입욕) 및 "], ["和샴푸", " 및 샴푸"],
  ["非즉시 씻어내는 제품", "즉시 씻어내지 않는 제품"], ["不宜使用本產品", "본 제품 사용에 부적합"],
  ["不得吞食", "삼키지 마십시오"], ["구강與眼部產品", "구강 및 눈 부위 제품"], ["구강與唇部產品", "구강 및 입술 부위 제품"],
  ["與眼部", " 및 눈 부위"], ["化粧品中", "화장품 중"], ["製劑", "제제"], ["3세 이하 아동產品", "3세 이하 아동 제품"],
  ["但沐浴", "단 목욕(입욕)"], ["皮膚有損傷、傷口或紅腫時不", "피부에 손상·상처·붉은 부기가 있을 때는 "],
  ["嬰兒及孩童不宜使用本產品", "영유아 및 아동은 본 제품 사용 부적합"],
  ["使用時皮膚如有異常現象", "사용 시 피부에 이상 증상이 나타나면"],
  ["以base計", "(염기로서 계산)"], ["以 base 計", "(염기로서 계산)"], ["以phenol計", "(페놀로서 계산)"],
  ["以 phenol 計", "(페놀로서 계산)"], ["以free SO2計", "(유리 SO2로서 계산)"],
  ["pH值", "pH값"], ["與눈 부위", " 및 눈 부위"], ["與입술 부위", " 및 입술 부위"], ["不適應症狀", "부적응 증상"],
  // 원문 중국어 복합어(다중패스라 순서 무관, 단 흔한 부분문자열[成分·為·中 등]은 긴 항목 파손 회피) + JP 가타카나
  ["可能吸入肺部產品", "폐에 흡입될 수 있는 제품"], ["抗頭皮屑", "비듬 방지"], ["未添加", "미첨가"], ["未첨가", "미첨가"],
  ["イソブチル", "이소부틸"], ["イソプロピル", "이소프로필"], ["メチル", "메틸"], ["エチル", "에틸"],
  ["含Chlorobutanol", "클로로부탄올 함유"], ["編號32及33成分", "번호 32 및 33 성분"],
  ["和propylparaben", " 및 propylparaben"], ["單一使用或混合", "단독 또는 혼합"],
  ["α-Hydroxy acids  成分，其함량為 10% 이하", "α-Hydroxy acids 성분, 그 함량이 10% 이하"],
  // 全체 문장 exact(긴 항목 부분문자열 아님). AHA 경고 등 — 1× exact-match 라 파손 위험 0.
  ["嬰兒及孩童不宜使用本產品", "영유아 및 아동은 본 제품 사용에 부적합"],
  ["使用後皮膚如有持續紅腫或出現不適應症狀時，請立即就醫診治", "사용 후 피부에 지속적 붉은 부기나 부적응 증상이 나타나면 즉시 진료받으십시오"],
  ["對皮膚容易引起刺激性", "피부에 자극을 일으키기 쉬움"], ["眼部化粧品", "눈 부위 화장품"],
  // TW 비고 원문 — 면책조항(立即沖洗産品 등) 부분문자열이 *아닌* 안전 복합어만.
  ["項次", "항목"], ["止汗劑及制臭劑", "발한억제제 및 체취억제제"], ["止汗制臭產品", "발한억제·체취억제(데오) 제품"],
  ["燙髮產品二劑", "퍼머넌트 제품 제2제"], ["非氧化性染髮產品", "비산화성 염모 제품"],
  ["用作Hydrogen peroxide 之安定劑不得超過", "Hydrogen peroxide 안정제로서 다음을 초과 금지: "],
  ["作為保護劑用途", "보존제 용도로서"], ["倘作為收斂劑用途", "만약 수렴제 용도로서"], ["作為收斂劑用途", "수렴제 용도로서"],
  ["限量", "한도"], ["相當於silver", "은(silver) 상당량"], ["口腔與眼部產品", "구강 및 눈 부위 제품"],
  ["不得使用於噴霧製劑", "분무 제제에 사용 금지"], ["噴霧製劑", "분무 제제"],
  ["與lignosulfate混合比例為1:1", "lignosulfate와 1:1 비율로 혼합"], ["本產品含二苯酮", "본 제품은 벤조페논 함유"],
  // 立即沖洗 류 — 전체 복합어(bare 立即沖洗 보다 길어 longest-first 우선매칭, 면책조항은 더 긴 항목이 먼저 처리).
  ["立即沖洗之髮用產品", "즉시 씻어내는 두발용 제품"], ["非立即沖洗之髮用產品", "즉시 씻어내지 않는 두발용 제품"],
  ["非立即沖洗之臉部產品", "즉시 씻어내지 않는 얼굴용 제품"], ["非立即沖洗產品", "즉시 씻어내지 않는 제품"],
  ["立即沖洗產品", "즉시 씻어내는 제품"], ["立即沖洗之", "즉시 씻어내는 "], ["髮用產品", "두발용 제품"], ["臉部產品", "얼굴용 제품"],
  ["單一使用或混合使用", "단독 또는 혼합 사용"], ["單一使用", "단독 사용"],
  ["計算", "계산"], ["規定", "규정"],
];
const PHRASE_SORTED = [...PHRASE].sort((a, b) => b[0].length - a[0].length);

// ── 영문 규제 보일러플레이트(EU CosIng·ASEAN·미국 FDA 등) 결정론 한글화 ──
// 사용자: 한글 기본값(영어 병기 허용), 단 *한글이 전혀 없는 영어전용* 조건문은 불가. MFDS 등이
// 영문 그대로 둔 EU CosIng 표준 문구를 한국어로 치환(화학명·INCI·CAS·Annex 번호 등 식별자는 보존).
// 결정론·가역·무Gemini(오번역 위험 0). 긴 구절 먼저 매칭(부분겹침 방지)·대소문자 무시 가능 항목은 lower.
const EN_PHRASE: [string, string][] = [
  // 섹션 헤더
  ["Field of application and/or use", "적용 범위 및/또는 용도"],
  ["Field of application", "적용 범위"],
  ["Maximum authorised concentration in the finished cosmetic product", "완제품 내 최대 허용 농도"],
  ["Maximum concentration in ready for use preparation", "사용 준비 제제 내 최대 농도"],
  ["Maximum concentration permitted at final product", "완제품 허용 최대 농도"],
  ["Maximum Concentration Permitted", "허용 최대 농도"],
  ["Other limitations and requirements", "기타 제한 및 요구사항"],
  ["Conditions of use and warning which must be printed on the labels", "라벨에 인쇄해야 할 사용조건 및 경고"],
  ["Use conditions and warnings that must appear on the label", "라벨에 표시해야 할 사용조건 및 경고"],
  ["Conditions of Use by product type", "제품 유형별 사용조건"],
  ["Warnings and Cautionary Statements", "경고 및 주의 문구"],
  ["Restrictions", "제한"],
  // 예외/제외 접두
  ["with the exception of the substances listed under reference number", "다음 참조번호로 열거된 물질 제외:"],
  ["with the exception of the substance under reference number", "다음 참조번호의 물질 제외:"],
  ["with the exception of the substances listed in", "다음에 열거된 물질 제외:"],
  ["with the exception of substance No", "다음 물질 제외: No"],
  ["with the exception of those specified elsewhere in this", "본 목록의 다른 곳에 별도 규정된 것 제외 —"],
  ["with the exception of those given in", "다음에 주어진 것 제외:"],
  ["with the exception of the one listed in", "다음에 열거된 것 제외:"],
  ["with the exception of derivatives cited in other positions in the list", "목록의 다른 항목에 기재된 유도체 제외"],
  ["with the exception of", "다음 제외:"],
  ["with exception of those derivatives listed elsewhere in this", "본 목록의 다른 곳에 열거된 유도체 제외:"],
  ["with exception of those given in", "다음에 주어진 것 제외:"],
  ["with exception of", "다음 제외:"],
  ["except for the uses provided for in", "다음에 규정된 용도 제외:"],
  ["except for the uses provided in", "다음에 규정된 용도 제외:"],
  ["except for normal content in the natural essences used and provided the concentration does not exceed", "사용된 천연 에센스의 정상 함량은 제외하며, 농도가 다음을 초과하지 않을 것:"],
  ["except for normal content in the natural essences used and provided that the concentration", "사용된 천연 에센스의 정상 함량은 제외하며, 농도가"],
  ["except for normal content in natural essences used", "사용된 천연 에센스의 정상 함량은 제외"],
  ["except when naturally occurring in plant extracts", "식물 추출물에 자연 함유된 경우 제외"],
  ["except for naturally occurring in plant extracts", "식물 추출물에 자연 함유된 경우 제외"],
  ["except as impurity in", "다음의 불순물로서는 제외:"],
  ["except those special cases included in", "다음에 포함된 특수 경우는 제외:"],
  ["except if the full refining history is known and it can be shown that the substance from which it is produced", "정제 이력이 완전히 알려져 있고 그 원료 물질이 다음을 입증할 수 있는 경우 제외:"],
  ["except for", "다음 경우 제외:"],
  ["except caffien", "카페인 제외"], ["except caffeine", "카페인 제외"],
  ["except sodium nitrite", "아질산나트륨 제외"], ["except. candelilla wax", "칸데릴라 왁스 제외"],
  ["except", "제외:"],
  // 용도/보존제
  ["For use other than as a preservative, see Annex III, No", "보존제 이외의 용도는 부속서 III, No 참조:"],
  ["For use other than as a preservative", "보존제 이외의 용도"],
  ["For non-preservative usage see Annex III. Part", "비보존제 용도는 부속서 III, Part 참조:"],
  ["For non-preservative usage", "비보존제 용도"],
  ["For use as a preservative, see Annex V, No", "보존제 용도는 부속서 V, No 참조:"],
  ["As a preservative, see Annexe VI, Part", "보존제로서는 부속서 VI, Part 참조:"],
  ["As a preservative", "보존제로서"],
  ["see Annexe", "부속서 참조:"], ["see Annex V, No", "부속서 V, No 참조:"],
  // 제품군/제형
  ["Hair waving or straightening products", "퍼머넌트 또는 스트레이트너(헤어 웨이브·스트레이트) 제품"],
  ["hair waving or straightening products", "퍼머넌트 또는 스트레이트너 제품"],
  ["oxidative hair dye products", "산화형 염모 제품"], ["non-oxidative hair dye products", "비산화형 염모 제품"],
  ["Hair dye substance in", "다음의 염모 성분:"], ["hair dye substance in", "다음의 염모 성분:"],
  ["hair and eyelash dye products", "모발 및 속눈썹 염색 제품"], ["hair dye products", "염모 제품"],
  ["Hair-care preparations", "두발용 제제"], ["Products for hair care", "두발 관리 제품"],
  ["Hair-care products which are removed after application", "사용 후 씻어내는 두발용 제품"],
  ["Other hair care products which are removed after application", "사용 후 씻어내는 기타 두발용 제품"],
  ["Skin-care preparations", "피부용 제제"], ["Products for skin care", "피부 관리 제품"],
  ["Nail hardening preparations", "손톱 경화용 제제"], ["Products to toughen nails", "손톱 강화 제품"],
  ["Oral hygiene products", "구강 위생 제품"], ["oral hygiene products", "구강 위생 제품"],
  ["Products for oral hygiene", "구강 위생 제품"], ["oral products", "구강용 제품"],
  ["Tooth-whitening products", "치아 미백 제품"], ["Mouthwashes", "구강청결제(가글)"],
  ["Shampoos and hair lotions", "샴푸 및 헤어 로션"], ["Depilatories", "제모제"],
  ["rinse-off products", "씻어내는(린스오프) 제품"], ["leave-on products", "씻어내지 않는(리브온) 제품"],
  ["Leave-on products intended for full body application", "전신 도포용 리브온 제품"],
  ["Leave-on products", "씻어내지 않는(리브온) 제품"], ["Leave-on", "리브온(씻어내지 않음)"],
  ["fine fragrance", "고급 향수"], ["eau de toilette", "오드뚜왈렛"], ["fragrance cream", "향료 크림"],
  ["other leave-on products and oral hygiene products", "기타 리브온 제품 및 구강 위생 제품"],
  ["other cosmetics", "기타 화장품"], ["Other cosmetics", "기타 화장품"],
  ["aerosol products", "에어로졸 제품"], ["aerosol cosmetic products", "에어로졸 화장품"],
  ["General use", "일반 용도"], ["Professional use", "전문가용"], ["For professional use only", "전문가 전용"],
  ["Colouring agents allowed in all cosmetic products except those", "다음을 제외한 모든 화장품에 허용된 착색제:"],
  ["Colouring agents allowed in all cosmetic products", "모든 화장품에 허용된 착색제"],
  ["Colouring agents allowed exclusively in cosmetic products intended for", "다음 용도 전용 화장품에만 허용된 착색제:"],
  ["Colouring agents allowed exclusively in cosmetic products", "특정 화장품 전용으로만 허용된 착색제"],
  // 공통 용어
  ["present or released", "존재 또는 방출"], ["ready for use at pH", "사용 시 pH"],
  ["ready for use", "사용 준비 상태"], ["as sulfur", "황으로서"], ["by weight of", "중량 기준"],
  ["These substances may be used singly or in combination provided that the sum of the", "이 물질들은 단독 또는 병용 사용 가능하나, 다음의 합이"],
  ["may be used singly or in combination", "단독 또는 병용 사용 가능"],
  ["The free base and salts of this hair colouring ingredient, unless prohibited under", "이 염모 성분의 유리 염기 및 염류(다음에서 금지된 경우 제외):"],
  ["The insoluble barium, strontium and zirconium lakes, salts and pigments of these col", "이 색소들의 불용성 바륨·스트론튬·지르코늄 레이크·염·안료"],
  // 경고문(고정)
  ["Hair colorants can cause severe allergic reactions.", "염모제는 심각한 알레르기 반응을 일으킬 수 있습니다."],
  ["Read and follow instructions.", "사용설명서를 읽고 따르십시오."],
  ["Read & follow the instructions and use the product accordingly.", "사용설명서를 읽고 따라 제품을 사용하십시오."],
  ["This product is not intended for use on persons under the age of", "이 제품은 다음 연령 미만에게 사용하도록 의도되지 않았습니다:"],
  ["Temporary “black henna” tattoos may increase your risk of allergy.", "일시적 '블랙 헤나' 문신은 알레르기 위험을 높일 수 있습니다."],
  ["Do not colour your hair if:", "다음의 경우 염색하지 마십시오:"],
  ["you have a rash on your face or sensitive, irritated and damaged scalp", "얼굴에 발진이 있거나 두피가 민감·자극·손상된 경우"],
  ["you have ever experienced any reaction after colouring your hair", "이전에 염색 후 어떤 반응을 경험한 적이 있는 경우"],
  ["you have experienced a reaction to a temporary “black henna” tattoo in the past", "과거 일시적 '블랙 헤나' 문신에 반응을 경험한 경우"],
  ["Follow the instructions", "사용설명서를 따르십시오"],
  ["Contains thioglycolate", "치오글라이콜레이트 함유"], ["Contains hydrogen peroxide", "과산화수소 함유"],
  ["Contains resorcinol", "레조르시놀 함유"], ["Contains alkali", "알칼리 함유"],
  ["Avoid contact with eyes", "눈에 닿지 않도록 하십시오"],
  ["In the event of contact with eyes, rinse immediately with plenty of water and", "눈에 들어간 경우 즉시 다량의 물로 헹구고"],
  ["In case of contact with eyes thoroughly rinse with wa", "눈에 닿은 경우 물로 충분히 헹구십시오"],
  ["Rinse eyes immediately if product comes into contact with them", "제품이 눈에 닿으면 즉시 눈을 헹구십시오"],
  ["Rinse eyes immediately if the product comes in contact with them", "제품이 눈에 닿으면 즉시 눈을 헹구십시오"],
  ["Wear suitable gloves", "적합한 장갑을 착용하십시오"], ["Use suitable gloves", "적합한 장갑을 사용하십시오"],
  ["Keep out of reach of children", "어린이의 손이 닿지 않는 곳에 보관하십시오"],
  ["Do not use with nitrosating systems", "니트로소화 물질과 함께 사용하지 마십시오"],
  ["Maximum nitrosamine content", "최대 니트로사민 함량"], ["Keep in nitrite-free containers", "아질산염이 없는 용기에 보관"],
  ["The direction for use “wear suitable gloves” must be included in label or leaflet text.", "'적합한 장갑 착용' 사용지침을 라벨 또는 설명서에 포함해야 합니다."],
  ["Use for dyeing eyelashes and eyebrows is not permitted.", "속눈썹·눈썹 염색 용도는 허용되지 않습니다."],
  ["Do not use to dye eyelashes or eyebrows", "속눈썹이나 눈썹 염색에 사용하지 마십시오"],
  ["Do not use on eyelashes or eyebrows", "속눈썹이나 눈썹에 사용하지 마십시오"],
  ["Rinse hair well after application", "사용 후 머리를 잘 헹구십시오"],
  ["Can cause blindness.", "실명을 유발할 수 있습니다."],
  ["Eyelid bonding: consult a physician.", "눈꺼풀 접착: 의사와 상담하십시오."],
  ["Not for direct sale to the general public", "일반 대중에게 직접 판매 불가"],
  ["Not for direct sale to the public", "일반 대중에게 직접 판매 불가"],
  ["These are prohibited in cosmetic products because they may cause serious skin di", "이들은 심각한 피부 질환을 유발할 수 있어 화장품에 금지됩니다"],
  ["The mixing ratio", "혼합 비율"], ["After mixing under oxidative conditions the max", "산화 조건에서 혼합 후 최대"],
  ["Adopted during the Fifth ASEAN Cosmetic Committee Meeting", "제5차 ASEAN 화장품위원회 회의에서 채택"],
  ["Exception for Indonesia : include this under Annex VI", "인도네시아 예외: 부속서 VI에 포함"],
  ["Exception for Indonesia: include it under Annex VI", "인도네시아 예외: 부속서 VI에 포함"],
  ["For case review, the applicant should submit relevant documents or information, includin", "사례 검토 시 신청자는 관련 문서 또는 정보를 제출해야 함:"],
  ["Category 1 material and Category 2 material as defined in Articles", "다음 조항에 정의된 카테고리 1 물질 및 카테고리 2 물질:"],
  ["water except for zinc hydroxybenzenesulphonate", "물(아연 하이드록시벤젠설포네이트 제외)"],
  ["unless regulated elsewhere in this Regulation", "본 규정의 다른 곳에 규정되지 않는 한"],
  ["unless proven that the extraction method does not produce polynuclear aromatic h", "추출법이 다환방향족 탄화수소를 생성하지 않음이 입증되지 않는 한"],
  ["Not permitted in cosmetics that contain amines or amides", "아민 또는 아미드를 함유한 화장품에는 허용되지 않음"],
  ["Not permitted in aerosol products", "에어로졸 제품에는 허용되지 않음"],
  ["Not permitted in cosmetics intended to be used on or around mucosal membranes", "점막 또는 그 주변에 사용하도록 의도된 화장품에는 허용되지 않음"],
  ["Not permitted in leave-on products", "리브온 제품에는 허용되지 않음"],
  ["In hair removal (depilatory) products", "제모(제모제) 제품에서"],
  ["Discontinue use if rash or irritation occurs.", "발진이나 자극이 생기면 사용을 중단하십시오."],
  ["Do not use on broken skin.", "상처 부위에 사용하지 마십시오."],
  // 물질 설명·금지 사유 노트
  ["Cosmetic products containing that substance that do not comply with the restrictions", "본 물질을 함유하나 제한사항을 준수하지 않는 화장품"],
  ["Mercury-containing cosmetic preparations have been represented for many years", "수은 함유 화장품 제제는 수년간 표방되어 왔음"],
  ["has been used as an ingredient in cosmetic products", "화장품에 성분으로 사용되어 왔음"],
  ["has been used as an ingredient of aerosol cosmetic products", "에어로졸 화장품의 성분으로 사용되어 왔음"],
  ["has been used to some extent as an antibacterial agent in cosmetic", "화장품에서 항균제로 어느 정도 사용되어 왔음"],
  ["Zirconium-containing complexes have been used as an ingredient in cosmetics", "지르코늄 함유 착물은 화장품에 성분으로 사용되어 왔음"],
  ["The use of chlorofluorocarbons in cosmetics as propellants in self-pressurized container", "자가 가압 용기 내 분사제로서 화장품에 클로로플루오로카본(CFC) 사용"],
  ["The use of zirconium-containing complexes in aerosol cosmetic products is prohib", "에어로졸 화장품에 지르코늄 함유 착물 사용은 금지됨"],
  ["The use of vinyl chloride is prohibited as an ingredient of aerosol products", "에어로졸 제품의 성분으로 염화비닐 사용은 금지됨"],
  ["Vinyl chloride has been used as an ingredient in cosmetic aerosol products", "염화비닐은 화장품 에어로졸 제품에 성분으로 사용되어 왔음"],
  ["Methylene chloride has been used as an ingredient of aerosol cosmetic produc", "메틸렌클로라이드는 에어로졸 화장품의 성분으로 사용되어 왔음"],
  ["is also regulated in entry", "항목 ...에서도 규제됨 entry"],
  ["The two entries are mutually ex", "두 항목은 상호 배타적"],
  ["is incompatible with the use of", "다음의 사용과 양립 불가:"],
  ["is the organic compound that conforms to the formula", "다음 화학식을 따르는 유기 화합물"],
  ["is the heterocyclic compound that conforms to", "다음을 따르는 헤테로고리 화합물"],
  // 치과의사 단서
  ["For use by the consumer under the supervision of a qualified dental practition", "유자격 치과의사의 감독 하에 소비자가 사용"],
  ["For application by a qualified dental practitioner only", "유자격 치과의사만 적용"],
  ["For supply only through a qualified dental practitioner", "유자격 치과의사를 통해서만 공급"],
  ["Only to be used by a qualified dental practitioner", "유자격 치과의사만 사용 가능"],
  ["Do not use the product within two weeks prior to, or immediately after dental rest", "치과 시술 2주 전 또는 직후에 제품을 사용하지 마십시오"],
  ["The directions for use drawn up in the national or official language(s) must oblig", "자국어 또는 공용어로 작성된 사용지침을 반드시 표시"],
  ["if the maximum theoretical concentration of releasable formaldehyde, irrespective", "방출 가능 포름알데히드의 최대 이론 농도가, ...에 관계없이"],
  // 시아노아크릴레이트(속눈썹 접착) 경고
  ["WARNING. BONDS SKIN INSTANTLY", "경고. 피부에 즉시 접착됨"],
  ["AVOID CONTACT WITH EYES, MOUTH", "눈·입 접촉을 피하십시오"],
  ["AND SKIN. KEEP AWAY FROM CHILDREN", "및 피부. 어린이 손이 닿지 않게 하십시오"],
  ["AVOID CONTACT WITH", "접촉을 피하십시오:"], ["EYES, MOUTH AND SKIN", "눈·입·피부"],
  ["KEEP AWAY FROM CHILDREN", "어린이 손이 닿지 않게 하십시오"],
  ["Skin bonding: soak and ease apart gently", "피부 접착 시: 물에 담가 부드럽게 떼어내십시오"],
  ["Not for use in the area of the eye", "눈 주위에는 사용 금지"],
  ["Eyelid bonding", "눈꺼풀 접착"],
  // 참조·구조
  ['See " Peroxide and peroxide-generating compounds "', "「과산화물 및 과산화물 생성 화합물」 참조"],
  ['See " Alpha-hydroxy acids "', "「알파-하이드록시산」 참조"],
  ["For (a) and (b)", "(a) 및 (b)의 경우"], ["(a) and (b)", "(a) 및 (b)"],
  ["(b) and (c)", "(b) 및 (c)"], ["b) and c)", "b) 및 c)"],
  ["Fine fragrances", "고급 향수"], ["Eau de toilette", "오드뚜왈렛"], ["Rinse-off products", "씻어내는 제품"],
  ["Avoid swallowing.", "삼키지 마십시오."],
  ["The product is not to be used by children under the age of", "이 제품은 다음 연령 미만 어린이가 사용해서는 안 됩니다:"],
  ["For pH adjustment in depilatories", "제모제의 pH 조정용"],
  // 추가 잔여(빈도순)
  ["Halogenated salicylanilides", "할로겐화 살리실아닐라이드"],
  ["The direction for use", "사용 지침"], ["must be included in label or leaflet", "을 라벨 또는 설명서에 포함해야 함"],
  ["wear suitable gloves", "적합한 장갑 착용"],
  ["Manufacturers must ensure that", "제조자는 다음을 보장해야 함:"],
  ["Manufacturers must possess the following", "제조자는 다음을 보유해야 함:"],
  ["Raw material specifications for", "다음의 원료 규격:"], ["Finished product specifications", "완제품 규격"],
  ["Identification of the method of analysis used to determine the levels", "함량 측정에 사용된 분석법의 명시"],
  ["In Hair dyes as an oxidizing colouring agent", "염모제에서 산화형 착색제로서"],
  ["As stabilizers for hydrogen peroxide in rinse-off hair products", "씻어내는 두발 제품의 과산화수소 안정제로서"],
  ["As stabilizers for hydrogen peroxide in leave-on hair products", "씻어내지 않는 두발 제품의 과산화수소 안정제로서"],
  ["as an impurity in", "다음의 불순물로서:"],
  ["Products for use on the skin for consumer use", "소비자용 피부 사용 제품"],
  ["total mono-AHA equivalents with a pH equal to or grea", "총 모노-AHA(알파하이드록시산) 당량, pH가 다음 이상:"],
  ['See " Mercury and its compounds "', "「수은 및 그 화합물」 참조"],
  ["Other applications", "기타 용도"], ["assist in the process of manufacturing", "제조 공정 보조"],
  ["total other PCDD/PCDF impurities, with no individual impurity greater", "기타 PCDD/PCDF 불순물 총량(개별 불순물은 다음을 초과하지 않을 것):"],
  ["with no individual impurity greater", "개별 불순물이 다음을 초과하지 않을 것:"],
  ["consult a physician", "의사와 상담하십시오"],
  ["with diameter < 3 μm, length > 5 μm and aspect ratio ≥ 3:1", "직경 < 3 μm, 길이 > 5 μm, 종횡비 ≥ 3:1"],
  ["For consumer use", "소비자용"], ["For professional use", "전문가용"],
  // EU 염모제/제한 라인 boilerplate(원문 오타 "Afther" 포함)
  ["Afther mixing under oxidative conditions the maximum concentration applied to", "산화 조건에서 혼합 후 다음에 적용되는 최대 농도"],
  ["After mixing under oxidative conditions the maximum concentration applied to", "산화 조건에서 혼합 후 다음에 적용되는 최대 농도"],
  ["For general use of hair waving or straightening products the maximum concentrati", "퍼머넌트·스트레이트너 제품의 일반 용도 최대 농도"],
  ["must not exceed", "을 초과해서는 안 됨"], ["shall not exceed", "을 초과해서는 안 됨"],
  ["applied to hair", "모발에 적용"], ["applied to eyelashes", "속눈썹에 적용"],
  ["as sulphate", "황산염으로서"], ["as sulfate", "황산염으로서"], ["calculated as the base", "염기로서 계산"],
  ["as the base", "염기로서"], ["nitrosating agent", "니트로소화제"],
  ["To be printed on the label", "라벨에 인쇄할 것"], ["printed on the label", "라벨에 인쇄"],
  ["Eyelashes shall not be coloured if the consumer", "다음의 경우 소비자는 속눈썹을 염색하지 말 것:"],
  ["Eyelashes shall not be coloured if", "다음의 경우 속눈썹을 염색하지 말 것:"],
  ["Contains phenylenediamines", "페닐렌디아민류 함유"], ["Contains phenylenediamine", "페닐렌디아민 함유"],
  ["This product cause severe allergic reactions", "이 제품은 심각한 알레르기 반응을 일으킬 수 있습니다"],
  ["can cause severe allergic reactions", "심각한 알레르기 반응을 일으킬 수 있습니다"],
  ["may increase the risk of allergy", "알레르기 위험을 높일 수 있습니다"],
  ["has experienced a reaction to a temporary", "일시적 ...에 반응을 경험한 적이 있는 경우"],
  ["the face or sensitive, irritated and damaged scalp", "얼굴 또는 민감·자극·손상된 두피"],
  ["Rinse hair well after application", "사용 후 머리를 잘 헹구십시오"],
  ["Other :", "기타 : "], ["Other limitations", "기타 제한"],
  // US/캐나다 허용·금지 단서 접두
  ["Not permitted in combination with", "다음과 병용은 허용되지 않음:"],
  ["Not permitted in products to be applied to mucous membranes", "점막에 적용하는 제품에는 허용되지 않음"],
  ["Not permitted in deodorants and antiperspirants in aerosol dispensers", "에어로졸 디스펜서 데오도란트·발한억제제에는 허용되지 않음"],
  ["Not permitted in cosmetics that contain amines or amides", "아민 또는 아미드를 함유한 화장품에는 허용되지 않음"],
  ["Not permitted in aerosol products", "에어로졸 제품에는 허용되지 않음"],
  ["Not permitted in leave-on products", "리브온 제품에는 허용되지 않음"],
  ["Not permitted in", "다음에는 허용되지 않음:"],
  ["Permitted only as barium sulfide in hair removal products", "제모 제품에서 황화바륨으로서만 허용"],
  ["Permitted only in nail products for professional use", "전문가용 손톱 제품에만 허용"],
  ["Permitted in hair dyes and nail products only", "염모제 및 손톱 제품에만 허용"],
  ["Permitted only in", "다음에만 허용:"], ["Permitted only as", "...로서만 허용:"],
  ["Deodorants and antiperspirants containing aluminum chloride are not p", "염화알루미늄 함유 데오도란트·발한억제제는 허용되지 않음"],
  ["Deodorants and antiperspirants", "데오도란트 및 발한억제제"],
  ["Cosmetics must not contain an isolated or concentrated phytocannabinoid", "화장품은 분리·농축된 파이토카나비노이드를 함유해서는 안 됨"],
  ["This product is not intended for use on broken or abraded skin", "이 제품은 상처나 찰과상이 있는 피부에 사용하도록 의도되지 않았습니다"],
  ["Do not use on broken or abraded skin", "상처나 찰과상이 있는 피부에 사용하지 마십시오"],
  ["not to be used by children und", "어린이가 사용해서는 안 됨"],
  ["In oxidative hair dye products", "산화형 염모 제품에서"], ["In non-oxidative hair dye products", "비산화형 염모 제품에서"],
  // 1× US/캐나다 물질별 노트 — 공통 패턴 + 개별
  ["Average daily absorption must be equal to or less than", "일일 평균 흡수량은 다음 이하여야 함:"],
  ["Cyanoacrylate adhesives for eyelash extensions must be sold for pro", "속눈썹 연장용 시아노아크릴레이트 접착제는 전문가용으로만 판매되어야 함"],
  ["Cyanoacrylate adhesives for eyelash extensions", "속눈썹 연장용 시아노아크릴레이트 접착제"],
  ["This product contains formaldehyde which has the potential to caus", "이 제품은 ...를 유발할 수 있는 포름알데히드를 함유함"],
  ["Manufacturers using substances of human origin must provide the follow", "인체 유래 물질을 사용하는 제조자는 다음을 제공해야 함:"],
  ["Oxidizing colouring agent for hair dyes", "염모제용 산화형 착색제"],
  ["Oxidizing colouring agent", "산화형 착색제"],
  ["Do not use in the area of the eye, mouth or nose", "눈·입·코 주위에 사용하지 마십시오"],
  ["Do not use in the area of the eye", "눈 주위에 사용하지 마십시오"],
  ["Cosmetics that contain more than", "다음을 초과하여 함유한 화장품:"],
  ["This product contains methacrylic acid, is poisonous, is to be kep", "이 제품은 메타크릴산을 함유하며 유독하므로 보관에 주의"],
  ["Cosmetics containing an amount of methyl alcohol equal to or greater t", "메틸알코올을 다음 이상 함유한 화장품:"],
  ["Cosmetics containing an amount of", "다음 양을 함유한 화장품:"],
  ["Not permitted for use in products intended for application to the g", "생식기 부위에 적용하도록 의도된 제품에는 사용이 허용되지 않음"],
  ["On the inner label and the outer label of the cosmetic", "화장품의 내부 라벨 및 외부 라벨에"],
  ["This product contains silver and/or silver salts.", "이 제품은 은 및/또는 은염을 함유함."],
  ["Avoid contact wit", "접촉을 피하십시오"],
  ["Note: Certain products may fall under more than 1 product category and", "주: 특정 제품은 2개 이상의 제품 카테고리에 해당할 수 있으며"],
  ["as thioglycolic acid", "치오글라이콜릭산으로서"], ["with a pH less than or equal to", "pH가 다음 이하:"],
  ["with a pH equal to or grea", "pH가 다음 이상:"], ["ready for use at pH", "사용 시 pH"],
  ["This product contains", "이 제품은 다음을 함유함:"],
  ["CAUTION", "주의"], ["WARNING", "경고"],
  ["must be sold for professional use", "전문가용으로만 판매되어야 함"],
  ["for professional use only", "전문가 전용"],
  // 마지막 1× 물질별 노트(TiO2 나노·BSE·비티오놀·벤젠 등)
  ["is the sodium salt of sulfanilic acid that confor", "는 설파닐산의 나트륨염"],
  ["if benzene is technically unavoidable to be present in cosmetics as", "벤젠이 기술적으로 불가피하게 화장품에 존재하는 경우"],
  ["Titanium dioxide in powder form containing", "분말 형태의 이산화티타늄으로 다음을 함유:"],
  ["Wording of conditions of use and warnings", "사용조건 및 경고 문구"],
  ["Not to be used in app", "다음에 사용하지 말 것: app"],
  ["Only nanomaterials having the following characteristics are allowed", "다음 특성을 가진 나노물질만 허용됨"],
  ["rutile form, or rutile with up to 5 % anatase, with crystalline st", "루타일 형태, 또는 아나타제 최대 5%를 포함한 루타일(결정 구조)"],
  ["coated with Silica, Hydrated Silica, Alumina, Aluminium Hydroxide,", "실리카·수화 실리카·알루미나·수산화알루미늄 등으로 코팅"],
  ["nanoparticles are photostable in the final formulation", "나노입자가 최종 제형에서 광안정성을 가짐"],
  ["For face products containing", "다음을 함유한 얼굴용 제품:"],
  ["powder form containing 1 % or more of particles with aerodynamic dia", "공기역학 직경 기준 입자를 1% 이상 함유한 분말 형태"],
  ["For use as Verbena essential oils (Lippia citriodora Kunth.) and", "버베나 에센셜 오일(Lippia citriodora Kunth.) 용도로 사용"],
  ["The use of bithionol is prohibited because it may cause photocontact", "비티오놀은 광접촉 반응을 유발할 수 있어 사용이 금지됨"],
  ["To protect against bovine spongiform encephalopathy (BSE)", "소해면상뇌증(BSE)을 예방하기 위해"],
  ["also known as", "또한 다음으로 알려진:"], ["mad cow disease", "광우병"],
  ["used by children under the age of", "다음 연령 미만 어린이 사용:"],
  ["coated with the", "다음으로 코팅:"], ["coated with", "다음으로 코팅:"],
  // JP MFDS 영어 주석(한국어 라벨 뒤 중복 gloss) 제거 + "as total" 한글화.
  ["(types or intended purposes of cosmetics)", ""], ["(Maximum amount of ingredient per 100 g)", ""],
  ["(Maximum amount of ingredient per 100g)", ""], [" as total", " 합계량으로"], ["as total", "합계량으로"],
];
const EN_PHRASE_SORTED = [...EN_PHRASE].sort((a, b) => b[0].length - a[0].length);
const HAS_LATIN = /[A-Za-z]{3,}/;
// 단어 경계(\b)+대소문자 무시 regex 선컴파일 — literal substring 은 "except"가 "exception" 내부에
// 발화해 "제외:ion" 처럼 단어를 깨고(실측), 대소문자 불일치("With" vs "with")로 긴 항목이 미스돼
// 짧은 항목이 오발화했다. \b 로 단어 단위 매칭, i 로 케이스 무관. 영문 시작/끝일 때만 \b 부착.
const EN_PHRASE_RE: [RegExp, string][] = EN_PHRASE_SORTED.map(([en, ko]) => {
  const esc = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = /^[A-Za-z0-9]/.test(en) ? "\\b" : "";
  const post = /[A-Za-z0-9]$/.test(en) ? "\\b" : "";
  return [new RegExp(pre + esc + post, "gi"), ko] as [RegExp, string];
});
function enPhraseTranslate(s: string): string {
  if (!HAS_LATIN.test(s)) return s;
  let out = s;
  for (const [re, ko] of EN_PHRASE_RE) out = out.replace(re, ko);
  // JP MFDS 중복 표기 dedup: "1.0 합계량으로(합계량으로 1.0 g)" → "1.0 (합계량으로 1.0 g)".
  out = out.replace(/\(합계량으로[\d.]+\)(?=\s*\(합계량으로)/g, "");
  out = out.replace(/합계량으로\s*(?=\(합계량으로)/g, "");
  out = out.replace(/\s{2,}/g, " ");
  return out;
}
const HAS_CJK = /[぀-ヿ一-鿿]/;
const CJK_G = /[぀-ヿ一-鿿]/g;
const HANGUL_G = /[가-힣]/g;
function phraseTranslate(s: string): string {
  if (!HAS_CJK.test(s)) return s;
  let out = s;
  // CN: "국문: [한국어] / 중문: [중국어 원문]" — 중복 원문(중문) *줄만* strip. ⚠[\s\S]*$(끝까지)는
  //   중문 줄 *뒤*의 한도값 줄(적용/농도·사용범위 5%·18%·8% 등)까지 통째로 삭제(실측 실데이터 손실).
  //   중문은 성분명 1줄이므로 그 줄([^\n]*)만 제거하고 이후 한국어 한도 줄은 보존.
  //   단, 중문 줄에 한도/범위 수치(%·含量大于 등)가 있으면(금지물질의 범위 한정자 — 예 미네랄울
  //   ">18% 알칼리산화물") 국문에 없을 수 있어 *보존*(이후 PHRASE/POST 가 한글화). 數値 없는 중문만 제거.
  out = out.replace(/\n?[ \t]*중문\s*[:：][^\n]*/gu, (m) => {
    if (/\d+(?:\.\d+)?\s*%|含量|大于|超過/.test(m)) return m;  // 범위 한정자 줄 보존(기존)
    // 국문 없는 중문 줄이라도 *의미 괄호정의*(≥6 한자 — 색소 화학명/제법 정의)는 국문에 없는
    //   고유 내용이라 salvage(이후 PHRASE/CN정의블록이 한글화). 색소명 단독(괄호 無)은 그대로 제거.
    const defs = (m.match(/[（(][^（()）]*[）)]/g) || []).filter((p) => (p.match(/[一-鿿]/g) || []).length >= 6);
    return defs.length ? "\n" + defs.join(" ") : "";
  });
  // CN/TW 금지물질 정의 내 범위 한정구(중문) 한글화.
  out = out.replace(/含量大于\s*/g, "함량이 ").replace(/[（(]以重量[計计][）)]/g, "(중량 기준)").replace(/以重量[計计]/g, "중량 기준");
  out = out.replace(/人造玻璃[质質]\s*[（(]?[硅矽]酸[盐鹽][）)]?纤[维維]/g, "인조 유리질(규산염) 섬유").replace(/[矿礦]石棉/g, "광석면");
  out = out.replace(/不[规規][则則]晶体排列/g, "불규칙 결정 배열").replace(/在本[规規]范中[别別][处處][详詳][细細][说說]明的那些除外/g, "본 규범의 다른 곳에 상세 규정된 것은 제외");
  out = out.replace(/[碱鹼]金属氧化物和[碱鹼]土金属氧化物/g, "알칼리금속산화물 및 알칼리토금속산화물");
  // CN 准用착색제 정의 괄호(국문 無, salvage된 7종 색소 정의) — 결정론 한글화(PHRASE_SORTED 비경유=cascade 0).
  out = out.replace(/在封闭容器内[,，]?\s*灼烧动物骨头获得的细黑粉[。.]?\s*主要由磷酸钙组成/g, "밀폐 용기 내에서 동물 뼈를 태워 얻은 미세 흑색 분말. 주로 인산칼슘으로 구성")
    .replace(/所含的钙[,，]?\s*镁或铁碳酸盐类[,，]?\s*氢氧化铁[,，]?\s*石英砂[,，]?\s*云母等等属于杂质/g, "함유된 칼슘·마그네슘 또는 철 탄산염류, 수산화철, 석영사, 운모 등은 불순물에 속함")
    .replace(/氧化铁着色的硅酸铝/g, "산화철로 착색한 규산알루미늄")
    .replace(/叶绿酸-?铜络合物/g, "엽록소산-구리 착화합물")
    .replace(/2-氨基-1,7-\s*二氢-6H-嘌呤-6-酮/g, "2-아미노-1,7-디하이드로-6H-퓨린-6-온")
    .replace(/β-阿朴胡萝卜素醛/g, "β-아포카로틴알")
    .replace(/8['’]-apo-β-胡萝卜素\s*-8['’]-酸乙酯/g, "8'-아포-β-카로틴-8'-산 에틸에스테르");
  // 다중 패스(stable까지) — 1-pass 는 부분번역 상태(예 "三歲以下孩童→3세 이하 아동" 후 남은 "…產品")에
  // 혼합 entry 가 매칭 안 되는 순서 의존이 있다. 값은 전부 한글(CJK 키 없음)이라 cascade 없이 수렴.
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    for (const [cjk, ko] of PHRASE_SORTED) if (out.includes(cjk)) out = out.split(cjk).join(ko);
    if (out === before) break;
  }
  // "以 X 計"(X=영문 화학명/원소만, TW '…로서 계산'). 한자 사이의 計(計算 등)는 \b 영문 경계로 보호.
  out = out.replace(/以\s*([A-Za-z][A-Za-z0-9 .'-]*[A-Za-z0-9])\s*計/g, "($1로서 계산)");
  // 병기형(중국어 원문 줄 + 한국어 번역 줄) 데이터: 한국어 번역이 함께 있을 때만 중국어-우세 줄을
  // 제거(원문 잔재 제거 → 한국어만 표시). 안전: 결과에 한글이 사라지면 원복(중국어-only 필드 보존).
  if (HAS_CJK.test(out) && out.includes("\n") && HANGUL_G.test(out)) {
    const kept = out.split("\n").filter((line) => {
      // ⚠ 한도값(N% / 농도) 또는 限量/배합한도 가 있는 줄은 *절대* 제거 안 함 — 그 한도가 이 줄에만
      //   있을 수 있어(예 TW "非藥用牙膏及漱口水 : 0.1%(以 boric acid 計)") 제거 시 한도 손실(실측).
      //   데이터 보존 우선. 남은 중국어 product-type 는 이후 POST/catch-all 이 한글화/정리.
      if (/\d+(?:\.\d+)?\s*%|限量|배합\s*한도|最大|max/i.test(line)) return true;
      const cjk = (line.match(CJK_G) || []).length;
      const kr = (line.match(HANGUL_G) || []).length;
      return !(cjk >= 3 && cjk > kr); // 중국어-우세(한글보다 많고 CJK 3+) 줄 = 원문 잔재 → 제거
    }).join("\n");
    if ((kept.match(HANGUL_G) || []).length >= 3) out = kept; // 한글이 남을 때만 채택
  }
  // 잔여 연결어 후처리 — *줄-제거 이후* 적용(중문-우세 줄 제거 휴리스틱을 깨지 않도록). 여기 남은 及/或/
  // 惟/與 는 한국어 줄 안의 화학명 리스트 사이 잔재("X及Y"·"A或B")뿐이라 순수 연결어 치환이 안전.
  if (HAS_CJK.test(out)) {
    out = out.replace(/\s*及\s*/g, " 및 ").replace(/\s*或\s*/g, " 또는 ")
             .replace(/惟\s*/g, "단(다만) ").replace(/\s*與\s*/g, " 및 ");
    // 잔여 복합/단어(줄-제거 후 한국어 줄 안의 잔재) — 안전지대(긴 항목 파손 0).
    const POST: [RegExp, string][] = [
      // calc 패턴(計算→계산이 multi-pass 에서 먼저 발화해 깨진 형태까지 유연 매칭).
      [/以[\s無水物무수물]*계산/g, "(무수물로 계산)"], [/물 기준[\s溶용]*[액液]*계산/g, "(수용액으로 계산)"],
      // JP 가타카나/문구
      [/ミツロウ/g, "밀랍"], [/サラシ/g, "백랍"], [/の配合量である場合?に限る?/g, "의 배합량인 경우에 한함"],
      [/イソプロビル|イソプロピル/g, "이소프로필"], [/に限る/g, "에 한함"], [/に限/g, "에 한함"], [/である場/g, "인 경우"],
      // AHA(#4) 중문 경고 — 한국어 번역이 직후 병기됨 → 중문 제거(빈문자).
      [/對皮膚容易引起刺激性[，,]?/g, ""], [/消費者使用時應注意下列事項[：:]?/g, ""], [/嬰兒及孩童不宜使用本產品[。.]?/g, ""],
      [/使用時皮膚如有異常現象[，,]?/g, ""], [/使用後皮膚如有持續紅腫或出現不適應症狀時[，,]?請立即就醫診治[。.]?/g, ""],
      [/化粧品中含\s*α-Hydroxy acids?\s*成分[，,]?其含量為[\s\d%以下]*[，,]?且產品\s*pH值?為[\s\d.以上]*[，,]?作為\s*pH調整劑/g, ""],
      [/其標籤[、,]?仿單或?包裝得免刊載前開[^。\n]*[。.]?/g, ""], [/前開注意事項/g, "앞의 주의사항"],
      [/製劑/g, "제제"], [/使用時/g, "사용 시 "], [/使用/g, "사용"], [/成分/g, "성분"], [/皮膚/g, "피부"],
      [/化粧品中/g, "화장품 중"], [/製品中|제품中/g, "제품 중"], [/超過/g, "초과"], [/限量/g, "한도"],
      [/無機物/g, "무기물"], [/有機物/g, "유기물"], [/倘/g, "만약 "], [/液を/g, "액을 "], [/末を/g, "분말을 "],
      [/イソブチル/g, "이소부틸"], [/イソプロピル/g, "이소프로필"], [/ブチル/g, "부틸"], [/プロピル/g, "프로필"],
      [/メチル/g, "메틸"], [/エチル/g, "에틸"], [/エステル/g, "에스테르"], [/液/g, "액"], [/苯酮/g, "벤조페논"],
      [/以水溶性|水溶性/g, "수용성"], [/油溶性/g, "유용성"], [/溶性/g, "용성"], [/以水/g, "물 기준"],
      [/無機物/g, "무기물"], [/無水/g, "무수"], [/無機/g, "무기"], [/損傷/g, "손상"], [/傷口/g, "상처"],
      [/紅腫/g, "붉은 부기"], [/產品/g, "제품"], [/製品/g, "제품"], [/值為/g, "값은 "], [/量為/g, "량은 "],
      [/如有異常現象/g, "이상 증상이 있으면"], [/サリチル/g, "살리실"], [/ビニル/g, "비닐"],
      [/パラオキシ安息香酸イソブチル/g, "파라옥시안식향산 이소부틸"], [/イソブチル/g, "이소부틸"], [/イソプロピル/g, "이소프로필"],
      [/以無水物計算/g, "(무수물로 계산)"], [/無水物計算/g, "무수물로 계산"], [/以水溶液計算/g, "(수용액으로 계산)"], [/水溶液計算/g, "수용액으로 계산"],
      [/非藥用牙膏及漱口水|非藥用牙膏 및 漱口水/g, "비의약용 치약 및 구강청결제"], [/牙膏/g, "치약"], [/漱口水/g, "구강청결제"],
      [/不boric acid/g, "boric acid 기준 아님"], [/不無水物/g, "무수물 아님"], [/不무수물/g, "무수물 아님"],
      [/安息香酸/g, "안식향산"], [/無水物/g, "무수물"], [/無水/g, "무수"],
      // orphan 단글자 — *POST 최후*(줄제거·multi-pass 후 한국어 줄 안 잔재). 긴 항목 파손 위험 없음.
      [/不得超過|不得초과/g, "초과 금지"], [/得免刊載/g, "기재 면제"], [/不得吞食/g, "삼키지 마십시오"],
      [/不得/g, "금지"], [/物계산|物計算/g, "물 계산"], [/溶액|溶液/g, "용액"], [/以\s/g, ""],
      [/及び/g, " 및 "], [/プロビル/g, "프로필"], [/混合比例/g, "혼합 비율"], [/比例/g, "비율"], [/混合/g, "혼합"],
      [/分別/g, "각각"], [/吞食/g, "삼킴"], [/容易引起刺激性/g, "자극을 일으키기 쉬움"], [/引起/g, "유발"], [/刺激性/g, "자극성"],
      [/物/g, "물"], [/溶/g, "용"], [/得/g, ""], [/但/g, "단(다만) "], [/於/g, ""], [/為/g, ""],
      [/對/g, ""], [/容/g, ""], [/易/g, ""], [/激/g, ""], [/非/g, "비"], [/の/g, "의 "], [/び/g, ""],
      [/[一-鿿぀-ヿ]/g, ""],  // 최후 안전망 — 위 모든 규칙 후에도 남은 단독 CJK 글자는 제거(한국어 줄 안 잔재뿐).
    ];
    for (const [re, ko] of POST) out = out.replace(re, ko);
  }
  return out;
}

import { strKey } from "./strhash";

// 표시 텍스트를 한글로 치환. 우선순위:
//  ① Gemini 번역 캐시(translations.json — 해시키, 전수·장기 자동 누적)
//  ② 결정론 seed(위 MAP — 출처명·핵심 조건은 CI 없이도 즉시 한글)
//  ③ 없으면 원문 그대로(부분 오역 0). null/undefined 보존.
// MFDS 공공데이터(식약처가 정리한 EU·ASEAN·중국 등 해외법령)는 조건문을 "원문^한국어번역"
// 이중언어로 제공한다(전수 9,838건·14개국). UI 에 "english^korean" 가 그대로 노출되던 문제 →
// 표시 시점에 한국어(보통 ^ 뒤) 측만 보이게 정리한다. 줄 단위(한 줄에 ^ 있을 때만)로, ^-분절 중
// 한글 포함 분절 우선(없으면 마지막=번역측). 결정론·가역(데이터 불변)·자가치유(daily refresh 무관).
function stripBilingual(s: string): string {
  if (s.indexOf("^") === -1) return s;
  return s.split("\n").map((line) => {
    if (line.indexOf("^") === -1) return line;
    const parts = line.split("^");
    // ⚠ "^"는 MFDS 데이터에서 *두 용도*: (1)"원문^한국어번역"(EU 조건문 등) (2)*항목/줄 구분자*
    //   (예 "(a)^1. 8%, pH 7~9.5^2. 11%^(b) 5%" — 여러 한도 항목). (1)만 한글측 채택하고 (2)는 *전
    //   분절 보존*해야 한다. 무조건 '첫 한글 분절만'은 (2)에서 8%·11%·5% 같은 한도값을 파괴(실측 버그).
    //   판별: 정확히 2분절 + 앞=외국어(한글 없음, 라틴/CJK 有) + 뒤=한글 → 번역쌍 → 한글측. 그 외 → 구분자.
    if (parts.length === 2 && /[A-Za-z一-鿿぀-ヿ]/.test(parts[0]) && !/[가-힣]/.test(parts[0]) && /[가-힣]/.test(parts[1])) {
      return parts[1].trim();
    }
    return parts.map((p) => p.trim()).filter(Boolean).join(" ");  // 항목 구분자 — 전 분절 보존(공백 결합).
  }).join("\n");
}

export function translateDisplay<T extends string | null | undefined>(
  s: T,
  cache?: Map<string, string> | null,
): T {
  if (s == null) return s;
  const str0 = s as string;
  if (cache) {
    const hit = cache.get(strKey(str0));
    // 캐시(Gemini 번역)에도 잔존 외국어가 있을 수 있어 동일 정리 파이프 적용(이중언어·CJK·영문 boilerplate).
    if (hit) return enPhraseTranslate(phraseTranslate(stripBilingual(hit))) as T;
  }
  // MFDS 이중언어("원문^한글") → 한글 측만. 이후 MAP/PHRASE 는 정리된 한글에 적용.
  const str = stripBilingual(str0);
  const direct = MAP[str] ?? MAP[str0];
  if (direct) return direct as T;
  const n = NORM_MAP[norm(str)] ?? NORM_MAP[norm(str0)];
  if (n) return n as T;
  // CJK boilerplate 구절 치환 + 영문 CosIng boilerplate 한글화(영어전용 조건문 = 한글 0 해소).
  const ph = enPhraseTranslate(phraseTranslate(str));
  if (ph !== str) return ph as T;
  return str as T;
}
