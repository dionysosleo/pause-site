/* 회원 탈퇴 (약관 제8조, 개인정보처리방침 보유 기간)
   - 로그인한 본인만. 계정(auth)과 회원 정보·수강권·진도·기기·동의 기록을 지움(DB에서 연쇄 삭제).
   - 주문 기록은 전자상거래법에 따라 5년 보관: 계정 연결만 끊고(user_id=null) detached_at을 남겨, 같은 이메일로 다시 가입해도 수강권을 되살리지 않음.
   - 수강평·질문은 작성자 표시 없이 남음. */
const S = require('../_sb.js');
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  if (!S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
  const b = await S.readJson(req);
  if (!b || b.confirm !== 'withdraw') return S.send(res, 400, { ok: false, code: 'CONFIRM' });
  const u = await S.user(S.bearer(req));
  if (!u) return S.send(res, 401, { ok: false, code: 'AUTH' });
  try {
    const o = await S.rest('PATCH', 'orders?user_id=eq.' + encodeURIComponent(u.id), { user_id: null, detached_at: new Date().toISOString() }, 'return=minimal');
    if (!o.ok) { console.error('detach orders', o.status, o.text); return S.send(res, 500, { ok: false, code: 'DB' }); }
    const d = await S.deleteAuthUser(u.id);
    if (!d.ok) { console.error('delete user', d.status, d.text); return S.send(res, 500, { ok: false, code: 'DELETE' }); }
    return S.send(res, 200, { ok: true });
  } catch (e) { console.error('withdraw', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
