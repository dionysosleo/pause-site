/* 결제 키 선택. 운영 키는 Vercel 환경 변수(PG_CLIENT_KEY, PG_SECRET_KEY)로만 넣어요.
   환경 변수가 없으면 토스페이먼츠 개발자 문서에 공개된 '결제위젯' 문서용 테스트 키(test_gck_docs / test_gsk_docs)를 씀 → 실제 청구 없는 테스트 결제.
   계약 후에는 개발자센터의 '결제위젯 연동 키'(gck/gsk)를 넣어요. (화면이 결제위젯 방식이라 '결제창 API 개별 연동 키'(ck/sk)와 섞으면 안 돼요)
   (이 테스트 키는 토스페이먼츠가 공개한 예시 키라 비밀이 아니에요. 계약 후 내 상점 키로 바꿔요.) */
const DOCS_TEST = { client: 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm', secret: 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6' };
module.exports = function keys() {
  const client = process.env.PG_CLIENT_KEY, secret = process.env.PG_SECRET_KEY;
  if (client && secret) return { client, secret, mode: /^live_/.test(client) ? 'live' : 'test' };
  return { client: DOCS_TEST.client, secret: DOCS_TEST.secret, mode: 'test' };
};
