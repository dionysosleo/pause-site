/* 결제가 '완료'된 주문의 뒷일: 수강권 만들기 + 주문 확인 메일.
   결제창 승인(confirm), 가상계좌 입금 알림(webhook), 운영자 직접 등록에서 같이 씀. */
const S = require('./_sb.js');
const MAIL = require('./_mail.js');
const CATALOG = require('../shop/catalog.json').items;
const label = (item, qty) => item.name + (item.head ? ' · ' + qty + '명' : (qty > 1 ? ' × ' + qty : ''));
async function fulfill(o, opt) {
  opt = opt || {};
  const item = CATALOG[o.item_id] || { name: o.item_id };
  let enrolled = false;
  if (o.user_id && item.grants) {
    const ex = await S.rest('GET', 'enrollments?select=id&revoked_at=is.null&source=eq.purchase&user_id=eq.' + o.user_id + '&course_id=eq.' + encodeURIComponent(item.grants));
    if (ex.ok && ex.data.length) enrolled = true;
    else { const e = await S.rest('POST', 'enrollments', { user_id: o.user_id, course_id: item.grants, source: 'purchase', order_id: o.id }, 'return=minimal'); enrolled = e.ok; if (!e.ok) console.error('enroll', e.status, e.text); }
  }
  if (opt.mail !== false) await MAIL.orderConfirm({ id: o.id, email: o.buyer_email, name: label(item, o.qty || 1), amount: o.amount, paidAt: o.paid_at, method: o.method, course: !!item.grants, kit: /차 키트/.test(String(item.note || '')), refundRule: item.refund ? '취소·환불정책 「' + item.refund + '」' : '', test: !!o.is_test });
  return { enrolled };
}
module.exports = { fulfill, label, CATALOG };
