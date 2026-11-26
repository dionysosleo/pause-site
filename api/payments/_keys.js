/* 결제 키 선택. 운영 키는 Vercel 환경 변수(PG_CLIENT_KEY, PG_SECRET_KEY)로만 넣어요.
   환경 변수가 없으면 토스페이먼츠 개발자 문서에 공개된 '결제창 연동' 테스트 키를 씀 → 실제 청구 없는 테스트 결제.
   (이 테스트 키는 토스페이먼츠가 공개한 예시 키라 비밀이 아니에요. 계약 후 내 상점 키로 바꿔요.) */
const DOCS_TEST = { client: 'test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq', secret: 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R' };
module.exports = function keys() {
  const client = process.env.PG_CLIENT_KEY, secret = process.env.PG_SECRET_KEY;
  if (client && secret) return { client, secret, mode: /^live_/.test(client) ? 'live' : 'test' };
  return { client: DOCS_TEST.client, secret: DOCS_TEST.secret, mode: 'test' };
};
