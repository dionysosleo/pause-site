/* 차 키트 배송지: 본인 주문에만, 발송 전까지 입력·수정 (보관: 배송 후 3개월, 개인정보처리방침) */
const S = require('./_sb.js');
const CATALOG = require('../shop/catalog.json').items;
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  if (!S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
  try {
    const u = await S.user(S.bearer(req));
    if (!u) return S.send(res, 401, { ok: false, code: 'AUTH' });
    const b = await S.readJson(req) || {};
    const id = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.orderId || '')) ? b.orderId : '';
    const name = String(b.name || '').trim().slice(0, 40), phone = String(b.phone || '').replace(/[^0-9]/g, '').slice(0, 11), addr = String(b.addr || '').trim().slice(0, 200), memo = String(b.memo || '').trim().slice(0, 100);
    if (!id || !name || !/^01[0-9]{8,9}$/.test(phone) || addr.length < 5) return S.send(res, 400, { ok: false, code: 'BAD_REQUEST' });
    const r = await S.rest('GET', 'orders?select=id,user_id,item_id,status,shipped_at&id=eq.' + encodeURIComponent(id));
    const o = r.ok && r.data && r.data[0];
    if (!o || o.user_id !== u.id || !/차 키트/.test(String((CATALOG[o.item_id] || {}).note || ''))) return S.send(res, 404, { ok: false, code: 'NO_ORDER' });
    if (o.shipped_at) return S.send(res, 409, { ok: false, code: 'SHIPPED' });
    if (!['paid', 'partial_refunded'].includes(o.status)) return S.send(res, 409, { ok: false, code: 'NOT_PAID' });
    const w = await S.rest('PATCH', 'orders?id=eq.' + encodeURIComponent(id), { ship_name: name, ship_phone: phone, ship_addr: addr, ship_memo: memo || null }, 'return=minimal');
    return w.ok ? S.send(res, 200, { ok: true }) : S.send(res, 500, { ok: false, code: 'DB' });
  } catch (e) { console.error('shipping', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
