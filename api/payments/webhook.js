/* 토스페이먼츠 웹훅 — 결제 상태가 바뀌면 토스가 이 주소로 알려 줌
   개발자센터 → 웹훅 → 주소 등록: https://www.chaand.ai/api/payments/webhook  (이벤트: PAYMENT_STATUS_CHANGED, DEPOSIT_CALLBACK)
   - 가상계좌 입금 완료 → 주문을 '결제 완료'로 바꾸고 수강권·확인 메일
   - 입금 기한 지남 → '기한 만료'
   - 토스 상점관리자에서 직접 취소·부분취소 → 환불 금액·상태를 맞춤(전액이면 수강권 회수)
   알림 본문은 믿지 않고, 받은 주문번호로 토스 결제 조회 API를 다시 불러 그 결과로만 바꿈. */
const S = require('../_sb.js');
const F = require('../_fulfill.js');
const KEYS = require('./_keys.js');

async function tossGet(path) {
  const { secret } = KEYS();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/' + path, { headers: { Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64') }, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

async function sync(orderId, callbackSecret) {
  const g = await S.rest('GET', 'orders?select=*&id=eq.' + encodeURIComponent(orderId));
  const o = g.ok && g.data && g.data[0];
  if (!o || o.source === 'manual') return 'no_order';
  if (callbackSecret && o.pg_secret && callbackSecret !== o.pg_secret) return 'bad_secret';
  const p = await tossGet('orders/' + encodeURIComponent(orderId));
  if (!p || p.orderId !== o.id || Number(p.totalAmount) !== o.amount) return 'no_payment';
  const now = new Date().toISOString(), patch = { pg_synced_at: now };
  let fulfil = false, revoke = false;   // revoke 는 아래 분기에서 쓰므로 먼저 선언
  if (p.status === 'DONE' && o.status === 'waiting') { patch.status = 'paid'; patch.paid_at = p.approvedAt || now; fulfil = true; }
  else if ((p.status === 'EXPIRED' || p.status === 'ABORTED') && o.status === 'waiting') patch.status = 'expired';
  /* 입금 확인 뒤 은행에서 입금이 취소된 경우: 다시 입금 대기로 돌리고 수강권 회수 */
  else if (p.status === 'WAITING_FOR_DEPOSIT' && (o.status === 'paid') && o.method === '가상계좌') { patch.status = 'waiting'; patch.paid_at = null; revoke = true; }
  else if (p.status === 'WAITING_FOR_DEPOSIT' && o.status === 'waiting' && p.virtualAccount && p.virtualAccount.dueDate) patch.due_at = p.virtualAccount.dueDate;
  else if (p.status === 'CANCELED' && o.status === 'waiting') patch.status = 'canceled';
  else if (p.status === 'CANCELED' || p.status === 'PARTIAL_CANCELED') {
    const cs = Array.isArray(p.cancels) ? p.cancels : [];
    const canceled = cs.reduce((s, c) => s + (Number(c.cancelAmount) || 0), 0);
    if (canceled > (o.refund_amount || 0)) {
      const last = cs[cs.length - 1] || {};
      patch.refund_amount = canceled; patch.status = canceled >= o.amount ? 'refunded' : 'partial_refunded';
      patch.refunded_at = last.canceledAt || now; patch.refund_reason = String(last.cancelReason || '토스 상점관리자에서 취소').slice(0, 190);
      revoke = canceled >= o.amount;
    }
  }
  const up = await S.rest('PATCH', 'orders?id=eq.' + encodeURIComponent(o.id), patch, 'return=minimal');
  if (!up.ok) { console.error('webhook update', up.status, up.text); return 'db_error'; }
  if (fulfil) await F.fulfill(Object.assign({}, o, patch));
  if (revoke) await S.rest('PATCH', 'enrollments?order_id=eq.' + encodeURIComponent(o.id) + '&revoked_at=is.null', { revoked_at: now }, 'return=minimal');
  if (patch.status || patch.refund_amount) await S.log(null, 'pg_webhook', o.id, { from: o.status, to: patch.status || o.status, refund: patch.refund_amount || null, pg: p.status });
  return patch.status || 'synced';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return S.send(res, 405, { ok: false });
  const b = await S.readJson(req) || {};
  const d = b.data && typeof b.data === 'object' ? b.data : b;   // PAYMENT_STATUS_CHANGED 는 data 안에, DEPOSIT_CALLBACK 은 바로 위에
  const orderId = String(d.orderId || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) return S.send(res, 200, { ok: true, skipped: true });
  try { const r = await sync(orderId, typeof b.secret === 'string' ? b.secret : ''); return S.send(res, 200, { ok: true, result: r }); }
  catch (e) { console.error('webhook', e && e.message); return S.send(res, 500, { ok: false }); }   // 500이면 토스가 다시 보냄
};
module.exports.sync = sync;
