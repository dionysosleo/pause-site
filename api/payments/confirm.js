/* 결제 승인 (서버 전용) — CHA&I
   - 결제창(PG) 인증 뒤 /pay/success 페이지가 이 주소로 paymentKey·orderId·amount를 보내면,
     여기서 금액을 서버 기준표(CATALOG)와 대조한 뒤 PG사 승인 API를 호출해요.
   - 운영 비밀키는 Vercel 환경 변수 PG_SECRET_KEY 에만 둬요. 코드·화면에는 절대 넣지 않아요. (없으면 _keys.js의 토스페이먼츠 공개 테스트 키로 '테스트 결제'만 됨)
   - 기본 연동 대상은 토스페이먼츠 승인 API(v1/payments/confirm). 다른 PG사를 고르면 confirmWithPg()만 바꾸면 돼요.
   - 상품 가격이 0이면 '준비 중(NOT_READY)'으로 답하고, 결제는 승인되지 않아요.
*/

/* 판매 상품 기준표는 shop/catalog.json 하나만 씀 (화면 가격 = 결제 금액). price가 0인 상품은 판매하지 않음.
   orderId 형식: <상품ID>_<수량>_<무작위>  예) agent-vod_1_k3j9x0q2m1za */
const CATALOG = require('../../shop/catalog.json').items;
/* 인원제 상품(head): 강사 고정분 + 1인 금액 × 인원(최소 청구 인원 이하는 최소 인원으로). 그 밖에는 단가 × 수량 */
const total = (item, qty) => item.head ? item.head.base + item.head.per * Math.max(qty, item.head.min) : item.price * qty;
const KEYS = require('./_keys.js');

const ALLOWED_HOSTS = ['www.chaand.ai', 'chaand.ai'];

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
  for await (const c of req) { size += c.length; if (size > 4096) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

async function confirmWithPg({ paymentKey, orderId, amount }, secret) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(secret + ':').toString('base64'),
        'Content-Type': 'application/json',
        'Idempotency-Key': orderId              // 같은 주문을 두 번 승인하지 않도록
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
      signal: ctl.signal
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data };
  } finally { clearTimeout(t); }
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

  const { secret, mode } = KEYS();
  const parts = orderId.split('_');
  const item = parts.length === 3 ? CATALOG[parts[0]] : null;
  const qty = parts.length === 3 ? Number(parts[1]) : NaN;
  if (!item || !item.price) return send(res, 503, { ok: false, code: 'NOT_READY' });          // 가격이 정해지지 않은 상품
  if (!Number.isInteger(qty) || qty < 1 || qty > (item.qtyMax || 1)) return send(res, 400, { ok: false, code: 'BAD_QTY' });
  if (total(item, qty) !== amount) return send(res, 400, { ok: false, code: 'AMOUNT_MISMATCH' });   // 화면에서 바뀐 금액은 승인하지 않음

  try {
    const { ok, data } = await confirmWithPg({ paymentKey, orderId, amount }, secret);
    if (!ok) return send(res, 402, { ok: false, code: String(data.code || 'PG_REJECTED').slice(0, 60), message: String(data.message || '').slice(0, 200) });
    // 카드번호 등 민감한 값은 돌려주지 않고 확인에 필요한 것만
    return send(res, 200, { ok: true, mode, orderId, orderName: item.name + (item.head ? ' · ' + qty + '명' : (qty > 1 ? ' × ' + qty : '')), amount, method: data.method || '', approvedAt: data.approvedAt || '' });
  } catch (e) {
    return send(res, 504, { ok: false, code: 'PG_TIMEOUT' });
  }
};
