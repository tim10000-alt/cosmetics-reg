// 결정론 문자열 해시 — 번역 캐시(translations.json) 키 생성용.
// Node 파이프라인(scripts/translate-fields.ts)과 브라우저(data-loader)가 *동일* 키를 만들어야
// 캐시 조회가 일치한다. FNV-1a 32bit + 길이 접미(충돌 추가 방어).
export function strKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + "." + s.length.toString(36);
}
