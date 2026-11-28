/* 결제 승인 (서버 전용) — CHA&I
   - 결제창(PG) 인증 뒤 /pay/success 페이지가 이 주소로 paymentKey·orderId·amount를 보내면,
     여기서 금액을 서버 기준표(CATALOG)와 대조한 뒤 PG사 승인 API를 호출해요.
   - 운영 비밀키는 Vercel 환경 변수 PG_SECRET_KEY 에만 둬요. 코드·화면에는 절대 넣지 않아요. (없으면 _keys.js의 토스페이먼츠 공개 테스트 키로 '테스트 결제'만 됨)
   - PG사 호출은 api/_pg (PG_PROVIDER) 한 곳에서. 금액·할인 계산은 api/_price.js 한 곳에서.
   - 승인은 됐는데 주문 저장이 실패하면 운영자에게 바로 알리고, 웹훅·매일 대사로 주문을 되살려요.
   - 상품 가격이 0이면 '준비 중(NOT_READY)'으로 답하고, 결제는 승인되지 않아요.
*/

/* 판매 상품 기준표는 shop/catalog.json 하나만 씀 (화면 가격 = 결제 금액). price가 0인 상품은 판매하지 않음.
   orderId 형식: <상품ID>_<수량>_<무작위>  예) agent-vod_1_k3j9x0q2m1za */
const CATALOG = require('../../shop/catalog.json').items;
const PG = require('../_pg');
const P = require('../_price.js');
const F = require('../_fulfill.js');
const OPS = require('../_ops.js');

const ALLOWED_HOSTS = ['www.chaand.ai', 'chaand.ai'];

/* 회원 DB(Supabase) 기록: 승인된 결제를 orders에 남기고, 로그인한 회원이면 수강권(enrollments)을 바로 만들어요.
   비밀 키는 Vercel 환경 변수 SUPABASE_SECRET_KEY 에만 둬요. 없으면 기록을 건너뛰고 결제 승인은 그대로 끝나요.
   비회원 결제는 같은 이메일로 가입·인증하면 내 학습에서 claim_orders()로 연결돼요. */
const SB_URL = 'https://mryawowqarptvtpxcwxl.supabase.co';
const SB_PUBLIC = 'sb_publishable_wC2dVRAITr3Ta5AmIzWpKQ_WyOV0OER';
async function sbUser(token) {
  if (!token || token.length > 4096) return null;
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUBLIC, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id && !(u.app_metadata && u.app_metadata.role === 'staff') ? u : null;   // 관리자 전용 계정은 구매자로 묶지 않음
  } catch (e) { return null; }
}
async function sbInsert(table, row, conflict) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) return { ok: false, skip: true };
  const r = await fetch(SB_URL + '/rest/v1/' + table + (conflict ? '?on_conflict=' + conflict : ''), {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=' + (conflict ? 'ignore-duplicates' : 'merge-duplicates') + ',return=minimal' },
    body: JSON.stringify(row)
  });
  return { ok: r.ok, status: r.status, text: r.ok ? '' : (await r.text()).slice(0, 300) };
}
async function record({ orderId, item, itemId, qty, price, pay, mode, buyer, token }) {
  try {
    const u = await sbUser(token);
    const email = String((u && u.email) || buyer.email || pay.email || '').slice(0, 100);
    /* 가상계좌는 승인 시점엔 '입금 대기'. 입금되면 PG가 웹훅(/api/payments/webhook)으로 알려 줌 */
    const waiting = pay.status === 'WAITING';
    const row = {
      id: orderId, user_id: u ? u.id : null, buyer_email: email, buyer_name: String(buyer.name || pay.name || '').slice(0, 80), buyer_phone: String(buyer.phone || '').replace(/[^0-9]/g, '').slice(0, 15) || null,
      item_id: itemId, qty, amount: price.amount, list_amount: price.list, discount: price.discount, coupon_code: price.coupon ? price.coupon.code : null,
      payment_key: pay.paymentKey || null, method: pay.method || null,
      status: waiting ? 'waiting' : 'paid', paid_at: waiting ? null : (pay.approvedAt || new Date().toISOString()), grants_course: item.grants || null, is_test: mode !== 'live',
      pg_secret: pay.secret || null, source: 'pg', vbank: pay.vbank || null, due_at: pay.vbank && pay.vbank.due || null,
      memo: buyer.when ? ('희망 진행 시기: ' + String(buyer.when).replace(/[\r\n]/g, ' ').slice(0, 60)) : null
    };
    const o = await sbInsert('orders', row, 'id');
    if (!o.ok) {
      if (!o.skip) console.error('orders insert', o.status, o.text);
      await OPS.alert('record_failed', orderId, '결제는 승인됐는데 주문 저장에 실패했어요', [['주문번호', orderId], ['상품', item.name], ['금액', OPS.won(price.amount)], ['구매자', email], ['조치', '웹훅·매일 대사가 다시 시도해요. 관리자 → 주문·환불에서 확인해 주세요.']]);
      return { saved: false };
    }
    if (price.coupon) await fetch(SB_URL + '/rest/v1/rpc/use_coupon', { method: 'POST', headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_code: price.coupon.code }) }).catch(() => {});
    await OPS.alert(waiting ? 'order_waiting' : 'order_paid', orderId, (waiting ? '가상계좌 주문 (입금 대기) · ' : '새 주문 · ') + item.name, [['주문번호', orderId], ['금액', OPS.won(price.amount) + (price.discount ? ' (할인 ' + OPS.won(price.discount) + ' · ' + price.coupon.title + ')' : '')], ['구매자', row.buyer_name + ' ' + email], ['결제 수단', row.method || '-'], ['테스트', row.is_test ? '예' : '아니요']], '/admin#orders');
    if (waiting) return { saved: true, member: !!u, enrolled: false, waiting: true, vbank: row.vbank };
    const f = await F.fulfill(Object.assign({}, row));
    return { saved: true, member: !!u, enrolled: f.enrolled };
  } catch (e) { console.error('record', e && e.message); return { saved: false }; }
}

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).end(JSON.stringify(body));
}

function sameOrigin(req) {
  const origin = req.headers.origin || '';
  try {
    const h = new URL(origin).host;
    return ALLOWED_HOSTS.includes(h) || h === req.headers.host;   // 실제 도메인 또는 같은 배포 주소(미리보기)에서 온 요청만
  } catch (e) { return false; }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 16384) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, code: 'METHOD' }); }
  if (!sameOrigin(req)) return send(res, 403, { ok: false, code: 'ORIGIN' });

  const b = await readJson(req);
  const paymentKey = b && typeof b.paymentKey === 'string' ? b.paymentKey : '';
  const orderId = b && typeof b.orderId === 'string' ? b.orderId : '';
  const amount = b ? Number(b.amount) : NaN;
  if (!paymentKey || paymentKey.length > 200 || !/^[A-Za-z0-9_-]{6,64}$/.test(orderId) || !Number.isInteger(amount) || amount <= 0) {
    return send(res, 400, { ok: false, code: 'BAD_REQUEST' });
  }

  const mode = PG.mode();
  const parts = orderId.split('_');
  const itemId = parts.length === 3 ? parts[0] : '';
  const item = CATALOG[itemId];
  if (!item || !item.price) return send(res, 503, { ok: false, code: 'NOT_READY' });          // 가격이 정해지지 않은 상품
  const buyer = b && typeof b.buyer === 'object' && b.buyer ? b.buyer : {};
  const price = await P.quote({ itemId, qty: Number(parts[1]), code: b.coupon, email: buyer.email });
  if (!price.ok) return send(res, 400, { ok: false, code: price.code });
  if (price.amount !== amount) return send(res, 400, { ok: false, code: 'AMOUNT_MISMATCH' });   // 화면에서 바뀐 금액은 승인하지 않음

  try {
    const c = await PG.confirm({ paymentKey, orderId, amount });
    if (!c.ok) return send(res, 402, { ok: false, code: c.code.slice(0, 60), message: c.message.slice(0, 200) });
    const pay = c.pay || {};
    const rec = await record({ orderId, item, itemId, qty: price.qty, price, pay, mode, buyer, token: b && typeof b.token === 'string' ? b.token : '' });
    // 카드번호 등 민감한 값은 돌려주지 않고 확인에 필요한 것만
    return send(res, 200, { ok: true, mode, waiting: !!rec.waiting, vbank: rec.vbank || null, saved: rec.saved, member: !!rec.member, enrolled: !!rec.enrolled, grants: !!item.grants, orderId, orderName: item.name + (item.head ? ' · ' + price.qty + '명' : (price.qty > 1 ? ' × ' + price.qty : '')), amount, discount: price.discount, coupon: price.coupon ? price.coupon.title : '', method: pay.method || '', approvedAt: pay.approvedAt || '' });
  } catch (e) {
    return send(res, 504, { ok: false, code: 'PG_TIMEOUT' });
  }
};
