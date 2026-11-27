/* 결제 취소 (전액·부분) — 실제 호출은 api/_pg (PG사별) */
const PG = require('./_pg');
async function cancel(paymentKey, amount, reason, idem, refundAccount) {
  const r = await PG.cancel({ paymentKey, amount, reason, idem, refundAccount });
  return { ok: r.ok, data: r.ok ? r.pay : { code: r.code, message: r.message } };
}
/* 취소 성공 뒤 주문·수강권 갱신 */
async function settle(S, o, amount, reason, revoke) {
  const total = (o.refund_amount || 0) + amount, full = total >= o.amount, now = new Date().toISOString();
  const up = await S.rest('PATCH', 'orders?id=eq.' + encodeURIComponent(o.id), { status: full ? 'refunded' : 'partial_refunded', refund_amount: total, refund_reason: reason, refunded_at: now }, 'return=minimal');
  if (!up.ok) console.error('order update after cancel', up.status, up.text);
  let revoked = false;
  if (revoke) { const rv = await S.rest('PATCH', 'enrollments?order_id=eq.' + encodeURIComponent(o.id) + '&revoked_at=is.null', { revoked_at: now }, 'return=minimal'); revoked = rv.ok; }
  try {
    const r = await S.rest('GET', 'orders?select=buyer_email,item_id&id=eq.' + encodeURIComponent(o.id));
    const x = r.ok && r.data && r.data[0];
    if (x) await MAIL.refundDone({ id: o.id, email: x.buyer_email, name: (CATALOG[x.item_id] || {}).name || x.item_id, refunded: amount, total, amount: o.amount, reason, revoked });
  } catch (e) { console.error('refund mail', e && e.message); }
  return { total, full, revoked, saved: up.ok };
}
module.exports = { cancel, settle };
