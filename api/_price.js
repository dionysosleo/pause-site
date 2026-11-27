/* 결제 금액 계산 (화면·서버 같은 식). 할인 코드·자동 할인을 여기서만 계산해요.
   - 정가: 인원제 상품은 강사 진행비 + 1인 금액 × 인원(최소 인원 이하는 최소 인원), 그 밖에는 단가 × 수량
   - 할인: 코드를 넣었거나, 기간 안의 자동 할인이 있으면 그중 할인이 가장 큰 하나만 (겹쳐 쓰지 않음)
   - 결제 승인 때 서버가 같은 계산을 다시 해서 금액이 다르면 승인하지 않아요 */
const S = require('./_sb.js');
const CATALOG = require('../shop/catalog.json').items;
const catOf = id => { const r = String((CATALOG[id] || {}).refund || ''); return /기업/.test(r) ? 'biz' : /살롱|원데이/.test(r) ? 'salon' : /기수|라이브|정기/.test(r) ? 'cohort' : /VOD/.test(r) ? 'vod' : 'etc'; };
const listPrice = (item, qty) => item.head ? item.head.base + item.head.per * Math.max(qty, item.head.min) : item.price * qty;
const cleanCode = c => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
function discountOf(c, list) {
  let d = c.kind === 'percent' ? Math.floor(list * Math.min(c.value, 100) / 100 / 10) * 10 : c.value;
  if (c.max_discount) d = Math.min(d, c.max_discount);
  return Math.max(0, Math.min(d, list));
}
async function usedBy(code, email) {
  if (!email) return 0;
  const r = await S.rest('GET', 'orders?select=id&coupon_code=eq.' + encodeURIComponent(code) + '&buyer_email=ilike.' + encodeURIComponent(email) + '&status=in.(paid,partial_refunded,waiting)');
  return r.ok ? r.data.length : 0;
}
/* 이 상품·금액·이메일에 쓸 수 있는지. 안 되면 이유 코드 */
async function check(c, itemId, list, email) {
  const now = Date.now();
  if (!c || !c.active) return 'NOT_FOUND';
  if (c.starts_at && Date.parse(c.starts_at) > now) return 'NOT_STARTED';
  if (c.ends_at && Date.parse(c.ends_at) < now) return 'ENDED';
  if (c.items && c.items.length && !c.items.includes(itemId)) return 'NOT_FOR_ITEM';
  if (c.cats && c.cats.length && !c.cats.includes(catOf(itemId))) return 'NOT_FOR_ITEM';
  if (list < (c.min_amount || 0)) return 'MIN_AMOUNT';
  if (c.max_uses != null && c.used >= c.max_uses) return 'SOLD_OUT';
  if (c.per_email && email && (await usedBy(c.code, email)) >= c.per_email) return 'USED';
  return '';
}
const MSG = { NOT_FOUND: '없는 코드예요.', NOT_STARTED: '아직 쓸 수 없는 코드예요.', ENDED: '기간이 끝난 코드예요.', NOT_FOR_ITEM: '이 상품에는 쓸 수 없는 코드예요.', MIN_AMOUNT: '최소 결제 금액이 모자라요.', SOLD_OUT: '준비한 수량이 모두 사용됐어요.', USED: '이미 사용한 코드예요.' };
async function quote({ itemId, qty, code, email }) {
  const item = CATALOG[itemId];
  if (!item || !item.price) return { ok: false, code: 'NOT_READY' };
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > (item.qtyMax || 1)) return { ok: false, code: 'BAD_QTY' };
  const list = listPrice(item, qty);
  email = String(email || '').trim().toLowerCase().slice(0, 100);
  code = cleanCode(code);
  let best = null, codeError = '';
  try {
    const q = 'coupons?select=*&active=is.true&or=(auto.is.true' + (code ? ',code.eq.' + encodeURIComponent(code) : '') + ')';
    const r = await S.rest('GET', q);
    for (const c of (r.ok ? r.data : [])) {
      const why = await check(c, itemId, list, email);
      if (c.code === code && !c.auto) { if (why) { codeError = why; continue; } }
      else if (why) continue;
      const d = discountOf(c, list);
      if (d > 0 && (!best || d > best.d)) best = { c, d };
    }
    if (code && !r.data.some(c => c.code === code)) codeError = 'NOT_FOUND';
  } catch (e) { console.error('quote', e && e.message); }
  const discount = best ? best.d : 0;
  return {
    ok: true, itemId, qty, list, discount, amount: list - discount,
    coupon: best ? { code: best.c.code, title: best.c.title, auto: best.c.auto } : null,
    codeError: code && (!best || best.c.code !== code) ? (codeError || 'NOT_BETTER') : '',
    codeMessage: code && (!best || best.c.code !== code) ? (MSG[codeError] || '이미 더 큰 할인이 적용돼 있어요.') : ''
  };
}
module.exports = { quote, listPrice, catOf, cleanCode, CATALOG };
