/* 고객 환불: 내 주문의 환불 예정 금액 보기(GET ?orderId=) · 환불 신청(POST {orderId})
   - 금액은 서버가 정책(_refund.js)으로 계산. 화면에서 보낸 금액은 받지 않음.
   - 자동 대상(VOD·사전 예약·파일 키트)은 바로 토스 취소 + 수강권 회수.
   - 그 밖(기수제·발송된 실물 키트)은 신청만 기록하고 운영자가 관리 탭에서 처리.
   - 운영자는 다른 사람 주문의 예정 금액도 볼 수 있음(관리 탭 기본값). */
const S = require('./_sb.js');
const R = require('./_refund.js');
const T = require('./_cancel.js');
const OPS = require('./_ops.js');
module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  if (req.method === 'POST' && !S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
  const u = await S.user(S.bearer(req));
  if (!u) return S.send(res, 401, { ok: false, code: 'AUTH' });
  const b = req.method === 'POST' ? (await S.readJson(req) || {}) : {};
  const orderId = String(req.method === 'GET' ? (req.query && req.query.orderId) || '' : b.orderId || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) return S.send(res, 400, { ok: false, code: 'BAD_REQUEST' });
  try {
    const q = await R.quote(orderId);
    if (!q.ok) return S.send(res, 404, q);
    const mine = q.order.user_id === u.id;
    if (!mine && !(req.method === 'GET' && await S.isAdminStrict(u, S.bearer(req)))) return S.send(res, 404, { ok: false, code: 'NO_ORDER' });
    /* 결제창 카드·간편결제만 바로 취소. 가상계좌(환불 계좌 필요)·직접 등록 거래는 신청으로 받아 운영자가 처리 */
    const po = (await S.rest('GET', 'orders?select=payment_key,method,source&id=eq.' + encodeURIComponent(orderId))).data[0] || {};
    if (q.auto && (!po.payment_key || po.source === 'manual' || po.method === '가상계좌')) { q.auto = false; q.rule += ' (이 결제 수단은 운영자가 확인 후 환불해요)'; }
    const view = { ok: true, orderId, paid: q.paid, already: q.already, amount: q.amount, auto: q.auto, rule: q.rule, days: q.days, watched: q.watched, total: q.total, requested: !!q.order.refund_requested_at };
    if (req.method === 'GET') return S.send(res, 200, view);
    if (!q.auto) {
      if (q.amount === 0) return S.send(res, 409, Object.assign(view, { ok: false, code: 'NOT_REFUNDABLE' }));
      await S.rest('PATCH', 'orders?id=eq.' + encodeURIComponent(orderId), { refund_requested_at: new Date().toISOString(), refund_request_note: String(b.note || '').slice(0, 300) }, 'return=minimal');
      await OPS.alert('refund_request', orderId + '@' + new Date().toISOString().slice(0, 10), '환불 신청이 들어왔어요', [['주문번호', orderId], ['회원', u.email], ['정책 계산', q.amount === null ? '사람 확인 필요' : OPS.won(q.amount)], ['기준', q.rule], ['메모', String(b.note || '-').slice(0, 300)]], '/admin#orders/requested');
      return S.send(res, 200, Object.assign(view, { requested: true, refunded: 0 }));
    }
    const o = (await S.rest('GET', 'orders?select=id,amount,refund_amount,status,payment_key&id=eq.' + encodeURIComponent(orderId))).data[0];
    if (!o.payment_key) return S.send(res, 409, { ok: false, code: 'NO_PAYMENT_KEY' });
    const c = await T.cancel(o.payment_key, q.amount, '고객 환불 신청 (' + q.rule.slice(0, 120) + ')', orderId + '-cancel-' + (q.already + q.amount));
    if (!c.ok) return S.send(res, 402, { ok: false, code: String(c.data.code || 'PG_REJECTED').slice(0, 60), message: String(c.data.message || '').slice(0, 200) });
    const st = await T.settle(S, o, q.amount, '고객 환불 신청: ' + q.rule, true);
    await OPS.alert('refund_auto', orderId + '@' + (q.already + q.amount), '고객이 직접 환불했어요 (정책 자동 계산)', [['주문번호', orderId], ['회원', u.email], ['환불 금액', OPS.won(q.amount)], ['기준', q.rule]], '/admin#orders');
    return S.send(res, 200, Object.assign(view, { refunded: q.amount, revoked: st.revoked }));
  } catch (e) { console.error('refund', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
