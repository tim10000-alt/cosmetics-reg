// 환경 독립 폴리필 (정품검증) — pdf-parse(PDFParse, pdfjs-dist) 가 모든 Node 환경에서 동작하게.
//
// 문제: pdfjs-dist 가 (1) Node 20.16/22.3+ 의 process.getBuiltinModule, (2) 브라우저 전역
// DOMMatrix 를 요구. CI(Node 24)에선 동작하나 구버전 Node(예: 20.11)·다른 머신에선
// "DOMMatrix is not defined" / "process.getBuiltinModule is not a function" 로 PDF 파싱 실패.
// → EU/JP 1차 데이터가 환경에 따라 갱신되거나 안 되는 비결정성.
//
// 해결: pdf-parse import 전에 최소 shim 주입. PDF "텍스트 추출"은 실제 DOMMatrix 연산이
// 불필요하므로 빈 stub 으로 충분(검증: Node 20.11 에서 EU 1223 PDF 371K chars 추출 성공).
//
// 이 모듈을 pdf-parse 사용 스크립트 최상단에서 side-effect import 하면 됨.
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
if (typeof proc.getBuiltinModule !== "function") {
  proc.getBuiltinModule = (id: string) => req(id.replace(/^node:/, ""));
}
const g = globalThis as unknown as { DOMMatrix?: unknown };
if (typeof g.DOMMatrix === "undefined") {
  g.DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  };
}
