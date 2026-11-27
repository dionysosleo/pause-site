/* 운영자용 주문 목록·환불 (admins 표에 있는 계정만)
   GET  → 최근 주문 50건
   POST {orderId, amount, reason, revoke} → 토스 결제 취소(전액·부분) 후 주문 상태 갱신, revoke면 수강권 회수
   환불 금액은 취소·환불정책에 따라 운영자가 정해 넣음(기본값은 남은 금액 전액). */
const S = require('../_sb.js');
const T = require('../_toss.js');

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  if (req.method === 'POST' && !S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
  const u = await S.user(S.bearer(req));
  try {
    if (!(await S.isAdmin(u))) return S.send(res, 403, { ok: false, code: 'NOT_ADMIN' });
    if (req.method === 'GET') {
      const r = await S.rest('GET', 'orders?select=id,item_id,amount,refund_amount,status,is_test,buyer_email,buyer_name,paid_at,user_id,grants_course,refunded_at,refund_requested_at,shipped_at&order=created_at.desc&limit=50');
      return r.ok ? S.send(res, 200, { ok: true, orders: r.data }) : S.send(res, 500, { ok: false, code: 'DB' });
    }
    const b = await S.readJson(req) || {};
    const orderId = typeof b.orderId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(b.orderId) ? b.orderId : '';
    const reason = String(b.reason || '').trim().slice(0, 190);
    const amount = Number(b.amount);
    if (!orderId || !reason || !Number.isInteger(amount) || amount <= 0) return S.send(res, 400, { ok: false, code: 'BAD_REQUEST' });
    const g = await S.rest('GET', 'orders?select=id,amount,refund_amount,status,payment_key&id=eq.' + encodeURIComponent(orderId));
    const o = g.ok && g.data && g.data[0];
    if (!o) return S.send(res, 404, { ok: false, code: 'NO_ORDER' });
    if (!o.payment_key || !['paid', 'partial_refunded'].includes(o.status)) return S.send(res, 409, { ok: false, code: 'NOT_REFUNDABLE' });
    const left = o.amount - (o.refund_amount || 0);
    if (amount > left) return S.send(res, 400, { ok: false, code: 'TOO_MUCH', left });
    const c = await T.cancel(o.payment_key, amount, reason, orderId + '-cancel-' + ((o.refund_amount || 0) + amount));
    if (!c.ok) return S.send(res, 402, { ok: false, code: String(c.data.code || 'PG_REJECTED').slice(0, 60), message: String(c.data.message || '').slice(0, 200) });
    const st = await T.settle(S, o, amount, reason, b.revoke !== false);
    const total = st.total, full = st.full, revoked = st.revoked;
    return S.send(res, 200, { ok: true, refunded: amount, total, full, revoked, saved: st.saved });
  } catch (e) { console.error('admin orders', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
