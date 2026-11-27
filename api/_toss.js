/* 토스 결제 취소 (전액·부분) */
const KEYS = require('./payments/_keys.js');
async function cancel(paymentKey, amount, reason, idem) {
  const { secret } = KEYS();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/' + encodeURIComponent(paymentKey) + '/cancel', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64'), 'Content-Type': 'application/json', 'Idempotency-Key': idem },
      body: JSON.stringify({ cancelReason: reason, cancelAmount: amount }), signal: ctl.signal
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data };
  } finally { clearTimeout(t); }
}
/* 취소 성공 뒤 주문·수강권 갱신 */
async function settle(S, o, amount, reason, revoke) {
  const total = (o.refund_amount || 0) + amount, full = total >= o.amount, now = new Date().toISOString();
  const up = await S.rest('PATCH', 'orders?id=eq.' + encodeURIComponent(o.id), { status: full ? 'refunded' : 'partial_refunded', refund_amount: total, refund_reason: reason, refunded_at: now }, 'return=minimal');
  if (!up.ok) console.error('order update after cancel', up.status, up.text);
  let revoked = false;
  if (revoke) { const rv = await S.rest('PATCH', 'enrollments?order_id=eq.' + encodeURIComponent(o.id) + '&revoked_at=is.null', { revoked_at: now }, 'return=minimal'); revoked = rv.ok; }
  return { total, full, revoked, saved: up.ok };
}
module.exports = { cancel, settle };
