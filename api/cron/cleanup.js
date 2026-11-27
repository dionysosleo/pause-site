/* 매일 새벽 정리 (Vercel 예약 작업, vercel.json crons)
   - 차 키트 배송 정보: 발송 후 3개월(90일)이 지나면 받는 분·연락처·주소·요청 사항을 지움 (개인정보처리방침 보유 기간)
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
    return S.send(res, 200, { ok: true, cleared: n });
  } catch (e) { console.error('cleanup', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
