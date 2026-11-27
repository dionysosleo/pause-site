/* 토스페이먼츠 연결부. 다른 PG사를 쓰면 같은 모양의 파일(예: _pg/nicepay.js)을 만들고 PG_PROVIDER 환경 변수만 바꿔요.
   모든 함수는 PG사 응답을 아래 '공통 모양'으로 바꿔서 돌려줘요. 나머지 코드는 PG사를 몰라도 돼요.
   공통 결제 모양: { orderId, paymentKey, status: DONE|WAITING|CANCELED|PARTIAL_CANCELED|EXPIRED|OTHER, total, canceledTotal,
                    cancels:[{amount, at, reason}], method, approvedAt, vbank:{bank,account,holder,due}|null, secret, email, name } */
const KEYS = require('../payments/_keys.js');
const API = 'https://api.tosspayments.com/v1/';
async function call(method, path, body, idem) {
  const { secret } = KEYS();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const h = { Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64') };
    if (body) h['Content-Type'] = 'application/json';
    if (idem) h['Idempotency-Key'] = idem;
    const r = await fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}
const ST = { DONE: 'DONE', WAITING_FOR_DEPOSIT: 'WAITING', CANCELED: 'CANCELED', PARTIAL_CANCELED: 'PARTIAL_CANCELED', EXPIRED: 'EXPIRED', ABORTED: 'EXPIRED' };
function norm(p) {
  if (!p || !p.orderId) return null;
  const cs = Array.isArray(p.cancels) ? p.cancels : [], va = p.virtualAccount || null;
  return {
    orderId: p.orderId, paymentKey: p.paymentKey, status: ST[p.status] || 'OTHER', total: Number(p.totalAmount) || 0,
    canceledTotal: cs.reduce((s, c) => s + (Number(c.cancelAmount) || 0), 0),
    cancels: cs.map(c => ({ amount: Number(c.cancelAmount) || 0, at: c.canceledAt, reason: c.cancelReason })),
    method: p.method || null, approvedAt: p.approvedAt || null, secret: p.secret || null,
    vbank: va ? { bank: va.bankCode || va.bank || '', account: va.accountNumber || '', holder: va.customerName || '', due: va.dueDate || '' } : null,
    email: (p.customerEmail || (p.receipt && p.receipt.email) || '') || null, name: p.customerName || null
  };
}
module.exports = {
  name: 'toss',
  label: '토스페이먼츠',
  mode: () => KEYS().mode,
  clientKey: () => KEYS().client,
  async confirm({ paymentKey, orderId, amount }) {
    const r = await call('POST', 'payments/confirm', { paymentKey, orderId, amount }, orderId);
    return r.ok ? { ok: true, pay: norm(r.data) } : { ok: false, code: String(r.data.code || 'PG_REJECTED'), message: String(r.data.message || '') };
  },
  async cancel({ paymentKey, amount, reason, idem, refundAccount }) {
    const body = { cancelReason: reason, cancelAmount: amount };
    if (refundAccount) body.refundReceiveAccount = refundAccount;   // { bank(은행 코드), accountNumber, holderName }
    const r = await call('POST', 'payments/' + encodeURIComponent(paymentKey) + '/cancel', body, idem);
    return r.ok ? { ok: true, pay: norm(r.data) } : { ok: false, code: String(r.data.code || 'PG_REJECTED'), message: String(r.data.message || '') };
  },
  async get(orderId) { const r = await call('GET', 'payments/orders/' + encodeURIComponent(orderId)); return r.ok ? norm(r.data) : null; },
  /* 거래 내역(대사용): from·to 는 'YYYY-MM-DDTHH:mm:ss' (한국 시간) */
  async list(from, to) {
    const out = []; let after = '';
    for (let i = 0; i < 20; i++) {
      const r = await call('GET', 'transactions?startDate=' + encodeURIComponent(from) + '&endDate=' + encodeURIComponent(to) + '&limit=100' + (after ? '&startingAfter=' + encodeURIComponent(after) : ''));
      if (!r.ok || !Array.isArray(r.data)) return { ok: false, items: out };
      r.data.forEach(x => out.push({ orderId: x.orderId, paymentKey: x.paymentKey, status: ST[x.status] || 'OTHER', amount: Number(x.amount) || 0, at: x.transactionAt, key: x.transactionKey }));
      if (r.data.length < 100) break; after = r.data[r.data.length - 1].transactionKey;
    }
    return { ok: true, items: out };
  },
  /* 상태 점검: 키가 맞는지만 확인 (없는 주문 조회 → 404면 연결·인증 정상, 401이면 키 문제) */
  async health() { try { const r = await call('GET', 'payments/orders/health-check-' + Date.now()); return r.status === 404 || r.ok; } catch (e) { return false; } },
  /* 웹훅 본문에서 주문번호와 확인용 값 꺼내기 (본문은 믿지 않고 get()으로 다시 조회) */
  hook(b) { const d = b && b.data && typeof b.data === 'object' ? b.data : (b || {}); return { orderId: String(d.orderId || ''), secret: typeof b.secret === 'string' ? b.secret : '' }; }
};
