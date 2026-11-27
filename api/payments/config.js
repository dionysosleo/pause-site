/* 결제 화면용 공개 값 + 금액 계산
   GET /api/payments/config                         → { clientKey, mode, provider }
   GET /api/payments/config?item=&qty=&code=&email= → 위 값 + price { list, discount, amount, coupon, codeMessage }
   비밀키는 절대 내보내지 않아요. 금액은 _price.js 한 곳에서만 계산해요 (승인 때도 같은 계산). */
const PG = require('../_pg');
const P = require('../_price.js');
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const out = { clientKey: PG.clientKey(), mode: PG.mode(), provider: PG.name, adminHost: process.env.ADMIN_HOST || '' };
  if (q.item) out.price = await P.quote({ itemId: String(q.item).replace(/[^a-z0-9-]/g, ''), qty: parseInt(q.qty, 10) || 1, code: q.code, email: q.email });
  res.status(200).end(JSON.stringify(out));
};
