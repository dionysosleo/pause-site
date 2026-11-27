/* 매일 새벽 정리 (Vercel 예약 작업, vercel.json crons)
   - 차 키트 배송 정보: 발송 후 3개월(90일)이 지나면 받는 분·연락처·주소·요청 사항을 지움 (개인정보처리방침 보유 기간)
   - 가상계좌 입금 기한이 지난 '입금 대기' 주문을 토스에 다시 조회해 만료·완료를 맞춤
   - Vercel 환경 변수 CRON_SECRET 이 있어야 실행됨 (Vercel이 같은 값을 Authorization 헤더로 보냄) */
const S = require('../_sb.js');
module.exports = async (req, res) => {
  const sec = process.env.CRON_SECRET;
  if (!sec) return S.send(res, 503, { ok: false, code: 'NO_CRON_SECRET' });
  if (req.headers.authorization !== 'Bearer ' + sec) return S.send(res, 401, { ok: false, code: 'AUTH' });
  try {
    const cut = new Date(Date.now() - 90 * 86400e3).toISOString();
    const r = await S.rest('PATCH', 'orders?shipped_at=lt.' + encodeURIComponent(cut) + '&ship_addr=not.is.null', { ship_name: null, ship_phone: null, ship_addr: null, ship_memo: null }, 'return=representation');
    const n = r.ok && Array.isArray(r.data) ? r.data.length : 0;
    if (n) await S.log(null, 'cleanup_shipping', null, { cleared: n });
    /* 가상계좌: 입금 기한이 지났는데 웹훅을 못 받은 주문은 토스에 다시 물어 맞춤 (기한은 토스 기준값을 그대로 씀) */
    const w = await S.rest('GET', 'orders?select=id&status=eq.waiting&due_at=lt.' + encodeURIComponent(new Date().toISOString()) + '&limit=50');
    const W = require('../payments/webhook.js'); let synced = 0;
    for (const o of (w.ok ? w.data : [])) { try { await W.sync(o.id); synced++; } catch (e) { console.error('cron sync', o.id, e && e.message); } }
    return S.send(res, 200, { ok: true, cleared: n, synced });
  } catch (e) { console.error('cleanup', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
