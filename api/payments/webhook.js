/* PG 웹훅 — 결제 상태가 바뀌면 PG사가 이 주소로 알려 줌 (토스: 개발자센터 → 웹훅 → https://www.chaand.ai/api/payments/webhook,
   이벤트 PAYMENT_STATUS_CHANGED · DEPOSIT_CALLBACK). 알림 본문은 믿지 않고 주문번호로 PG에 다시 조회한 결과로만 바꿔요.
   - 가상계좌 입금 완료 → 결제 완료·수강권·메일 / 기한 지남 → 기한 만료 / 은행에서 입금 취소 → 다시 입금 대기
   - PG 상점관리자에서 직접 취소·부분취소 → 환불 금액·상태 맞춤(전액이면 수강권 회수)
   - 우리 DB에 없는 주문(승인 직후 저장 실패 등) → 주문을 되살리고 운영자에게 알림 */
const S = require('../_sb.js');
const F = require('../_fulfill.js');
const PG = require('../_pg');
const OPS = require('../_ops.js');
const CATALOG = require('../../shop/catalog.json').items;

async function recover(p) {
  const parts = p.orderId.split('_'), item = CATALOG[parts[0]];
  if (!item || !['DONE', 'WAITING'].includes(p.status)) return 'no_order';
  const qty = Math.max(parseInt(parts[1], 10) || 1, 1), email = String(p.email || '').toLowerCase();
  let user = null;
  if (email) { const r = await S.rest('GET', 'profiles?select=id&email=ilike.' + encodeURIComponent(email)); user = r.ok && r.data[0] ? r.data[0].id : null; }
  const row = { id: p.orderId, user_id: user, buyer_email: email || 'unknown@chaand.ai', buyer_name: String(p.name || '').slice(0, 80), item_id: parts[0], qty, amount: p.total,
    payment_key: p.paymentKey, method: p.method, status: p.status === 'WAITING' ? 'waiting' : 'paid', paid_at: p.status === 'DONE' ? (p.approvedAt || new Date().toISOString()) : null,
    grants_course: item.grants || null, is_test: PG.mode() !== 'live', source: 'pg', vbank: p.vbank, due_at: p.vbank && p.vbank.due || null, pg_secret: p.secret,
    memo: 'PG 기록으로 자동 복구한 주문', pg_synced_at: new Date().toISOString() };
  const w = await S.rest('POST', 'orders?on_conflict=id', row, 'resolution=ignore-duplicates,return=minimal');
  if (!w.ok) { console.error('recover', w.status, w.text); return 'db_error'; }
  if (row.status === 'paid') await F.fulfill(row);
  await OPS.alert('recovered', p.orderId, 'PG 기록으로 주문을 되살렸어요', [['주문번호', p.orderId], ['상품', item.name], ['금액', OPS.won(p.total)], ['구매자', email || '(PG에 이메일 없음, 확인 필요)']], '/admin#orders');
  return 'recovered';
}

async function sync(orderId, callbackSecret) {
  const g = await S.rest('GET', 'orders?select=*&id=eq.' + encodeURIComponent(orderId));
  const o = g.ok && g.data && g.data[0];
  if (o && o.source === 'manual') return 'manual';
  if (o && callbackSecret && o.pg_secret && callbackSecret !== o.pg_secret) return 'bad_secret';
  const p = await PG.get(orderId);
  if (!p || p.orderId !== orderId) return 'no_payment';
  if (!o) return recover(p);
  if (p.total !== o.amount) return 'amount_mismatch';
  const now = new Date().toISOString(), patch = { pg_synced_at: now };
  let fulfil = false, revoke = false;
  if (p.status === 'DONE' && o.status === 'waiting') { patch.status = 'paid'; patch.paid_at = p.approvedAt || now; fulfil = true; }
  else if (p.status === 'EXPIRED' && o.status === 'waiting') patch.status = 'expired';
  else if (p.status === 'CANCELED' && o.status === 'waiting') patch.status = 'canceled';
  else if (p.status === 'WAITING' && o.status === 'paid' && o.method === '가상계좌') { patch.status = 'waiting'; patch.paid_at = null; revoke = true; }   // 은행에서 입금 취소
  else if (p.status === 'WAITING' && o.status === 'waiting' && p.vbank && p.vbank.due) patch.due_at = p.vbank.due;
  else if ((p.status === 'CANCELED' || p.status === 'PARTIAL_CANCELED') && p.canceledTotal > (o.refund_amount || 0)) {
    const last = p.cancels[p.cancels.length - 1] || {};
    patch.refund_amount = p.canceledTotal; patch.status = p.canceledTotal >= o.amount ? 'refunded' : 'partial_refunded';
    patch.refunded_at = last.at || now; patch.refund_reason = String(last.reason || 'PG 상점관리자에서 취소').slice(0, 190);
    revoke = p.canceledTotal >= o.amount;
  }
  const up = await S.rest('PATCH', 'orders?id=eq.' + encodeURIComponent(o.id), patch, 'return=minimal');
  if (!up.ok) { console.error('webhook update', up.status, up.text); return 'db_error'; }
  if (fulfil) { await F.fulfill(Object.assign({}, o, patch)); await OPS.alert('deposit', o.id, '가상계좌 입금 확인 · ' + ((CATALOG[o.item_id] || {}).name || o.item_id), [['주문번호', o.id], ['금액', OPS.won(o.amount)], ['구매자', o.buyer_name + ' ' + o.buyer_email]], '/admin#orders'); }
  if (revoke) await S.rest('PATCH', 'enrollments?order_id=eq.' + encodeURIComponent(o.id) + '&revoked_at=is.null', { revoked_at: now }, 'return=minimal');
  if (patch.status || patch.refund_amount) await S.log(null, 'pg_webhook', o.id, { from: o.status, to: patch.status || o.status, refund: patch.refund_amount || null, pg: p.status });
  return patch.status || 'synced';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return S.send(res, 405, { ok: false });
  const b = await S.readJson(req) || {};
  const h = PG.hook(b);
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(h.orderId)) return S.send(res, 200, { ok: true, skipped: true });
  try { const r = await sync(h.orderId, h.secret); return S.send(res, 200, { ok: true, result: r }); }
  catch (e) { console.error('webhook', e && e.message); return S.send(res, 500, { ok: false }); }   // 500이면 PG가 다시 보냄
};
module.exports.sync = sync;
