/* 매일 새벽 3시(한국 시간) 예약 작업 — Vercel Cron (vercel.json crons). Vercel 환경 변수 CRON_SECRET 이 있어야 실행돼요.
   1) 차 키트 배송 정보: 발송 후 90일 지나면 지움 (개인정보처리방침)
   2) 접속 기록·문의 접수: 1년 지나면 지움 (개인정보처리방침)
   3) 가상계좌: 입금 기한이 지난 '입금 대기' 주문을 PG에 다시 조회해 맞춤
   4) PG 대사: 최근 2일 PG 거래 중 우리 DB에 없는 주문을 되살리고 운영자에게 알림
   5) 어제 요약 메일 (운영자)
   6) 일요일: 주간 백업 (비공개 저장소, 최근 8개) */
const S = require('../_sb.js');
const PG = require('../_pg');
const W = require('../payments/webhook.js');
const MAIL = require('../_mail.js');
const BK = require('../_backup.js');
const won = n => Number(n || 0).toLocaleString('ko-KR') + '원';
const iso = t => new Date(t).toISOString();
const kst = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 19);

module.exports = async (req, res) => {
  const sec = process.env.CRON_SECRET;
  if (!sec) return S.send(res, 503, { ok: false, code: 'NO_CRON_SECRET' });
  if (req.headers.authorization !== 'Bearer ' + sec) return S.send(res, 401, { ok: false, code: 'AUTH' });
  const out = {}, now = Date.now();
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = 'error: ' + (e && e.message); console.error('cron', name, e && e.message); } };

  await step('shipping', async () => {
    const r = await S.rest('PATCH', 'orders?shipped_at=lt.' + encodeURIComponent(iso(now - 90 * 864e5)) + '&ship_addr=not.is.null', { ship_name: null, ship_phone: null, ship_addr: null, ship_memo: null }, 'return=representation');
    return r.ok ? r.data.length : 'db ' + r.status;
  });
  await step('access_logs', async () => { const r = await S.rest('DELETE', 'access_logs?at=lt.' + encodeURIComponent(iso(now - 365 * 864e5)), undefined, 'return=representation'); return r.ok ? r.data.length : 'db ' + r.status; });
  await step('leads', async () => { const r = await S.rest('DELETE', 'leads?created_at=lt.' + encodeURIComponent(iso(now - 365 * 864e5)), undefined, 'return=representation'); return r.ok ? r.data.length : 'db ' + r.status; });
  await step('vbank', async () => {
    const w = await S.rest('GET', 'orders?select=id&status=eq.waiting&due_at=lt.' + encodeURIComponent(iso(now)) + '&limit=50');
    let n = 0; for (const o of (w.ok ? w.data : [])) { await W.sync(o.id); n++; } return n;
  });
  await step('reconcile', async () => {
    const l = await PG.list(kst(now - 2 * 864e5), kst(now));
    if (!l.ok) return 'pg list failed';
    const ids = [...new Set(l.items.map(x => x.orderId).filter(id => /^[A-Za-z0-9_-]{6,64}$/.test(id)))];
    if (!ids.length) return 0;
    const have = await S.rest('GET', 'orders?select=id&id=in.(' + ids.map(encodeURIComponent).join(',') + ')');
    const set = new Set((have.ok ? have.data : []).map(o => o.id));
    let n = 0; for (const id of ids) if (!set.has(id)) { const r = await W.sync(id); if (r === 'recovered') n++; }
    return n;
  });
  await step('summary', async () => {
    const d0 = new Date(now + 9 * 3600e3); d0.setUTCHours(0, 0, 0, 0);
    const to = iso(d0.getTime() - 9 * 3600e3), from = iso(d0.getTime() - 9 * 3600e3 - 864e5);
    const [os, rf, ms, ls, todo] = await Promise.all([
      S.rest('GET', 'orders?select=amount,source,is_test&status=in.(paid,partial_refunded,refunded)&paid_at=gte.' + encodeURIComponent(from) + '&paid_at=lt.' + encodeURIComponent(to)),
      S.rest('GET', 'orders?select=refund_amount&refunded_at=gte.' + encodeURIComponent(from) + '&refunded_at=lt.' + encodeURIComponent(to) + '&is_test=is.false'),
      S.rest('GET', 'profiles?select=id&created_at=gte.' + encodeURIComponent(from) + '&created_at=lt.' + encodeURIComponent(to)),
      S.rest('GET', 'leads?select=kind&created_at=gte.' + encodeURIComponent(from) + '&created_at=lt.' + encodeURIComponent(to)),
      S.rest('GET', 'orders?select=status,refund_requested_at,shipped_at,item_id&status=in.(paid,waiting)')
    ]);
    const real = (os.data || []).filter(o => !o.is_test);
    const T = todo.data || [], CAT = require('../../shop/catalog.json').items;
    const rows = [['어제 주문', real.length + '건 · ' + won(real.reduce((s, o) => s + o.amount, 0))], ['어제 환불', won((rf.data || []).reduce((s, o) => s + (o.refund_amount || 0), 0))], ['새 회원', (ms.data || []).length + '명'], ['새 문의', (ls.data || []).length + '건'],
      ['환불 신청 대기', T.filter(o => o.status === 'paid' && o.refund_requested_at).length + '건'], ['가상계좌 입금 대기', T.filter(o => o.status === 'waiting').length + '건'], ['키트 발송 대기', T.filter(o => o.status === 'paid' && !o.shipped_at && /차 키트/.test(String((CAT[o.item_id] || {}).note || ''))).length + '건']];
    const m = await MAIL.ops('어제 요약 (' + from.slice(0, 10) + ')', rows, '/admin');
    return m.sent ? 'sent' : (m.skipped ? 'mail not set' : 'failed');
  });
  if (new Date(now + 9 * 3600e3).getUTCDay() === 0 || req.query.backup === '1') await step('backup', () => BK.run('weekly'));
  await S.rest('POST', 'ops_alerts', { kind: 'cron_run', ref: new Date(now).toISOString(), sent: true }, 'return=minimal');
  await S.rest('DELETE', 'ops_alerts?kind=eq.cron_run&at=lt.' + encodeURIComponent(iso(now - 30 * 864e5)), undefined, 'return=minimal');
  return S.send(res, 200, { ok: true, out });
};
