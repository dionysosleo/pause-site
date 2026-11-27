/* 매일 새벽 3시(한국 시간) 예약 작업 — Vercel Cron (vercel.json crons). Vercel 환경 변수 CRON_SECRET 이 있어야 실행돼요.
   1) 차 키트 배송 정보: 발송 후 90일 지나면 지움 (개인정보처리방침)
   2) 접속 기록·문의 접수: 1년 지나면 지움 (개인정보처리방침)
   3) 가상계좌: 입금 기한이 지난 '입금 대기' 주문을 PG에 다시 조회해 맞춤
   4) PG 대사: 최근 2일 PG 거래 중 우리 DB에 없는 주문을 되살리고 운영자에게 알림
   5) 어제 데일리 브리핑: 저장(대시보드 맨 위) + 운영자 메일
   6) 일요일: 주간 백업 (비공개 저장소, 최근 8개) */
const S = require('../_sb.js');
const PG = require('../_pg');
const W = require('../payments/webhook.js');
const MAIL = require('../_mail.js');
const BK = require('../_backup.js');
const BR = require('../_brief.js');
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
  await step('briefing', async () => {
    /* 어제(한국 날짜) 데일리 브리핑을 만들어 저장하고 운영자에게 메일 */
    const day = BR.kstDate(now - 864e5);
    const br = await BR.build(day);
    await BR.save(br);
    const rows = [['요약', br.headline]].concat(br.points.map(x => ['', '· ' + x])).concat(br.todos.length ? [['오늘 할 일', br.todos.map(t => '· ' + t.t).join('\n')]] : []);
    const m = await MAIL.ops('데일리 브리핑 ' + day, rows, '/admin#home');
    return m.sent ? 'sent' : (m.skipped ? 'saved (mail not set)' : 'saved (mail failed)');
  });
  if (new Date(now + 9 * 3600e3).getUTCDay() === 0 || req.query.backup === '1') await step('backup', () => BK.run('weekly'));
  await S.rest('POST', 'ops_alerts', { kind: 'cron_run', ref: new Date(now).toISOString(), sent: true }, 'return=minimal');
  await S.rest('DELETE', 'ops_alerts?kind=eq.cron_run&at=lt.' + encodeURIComponent(iso(now - 30 * 864e5)), undefined, 'return=minimal');
  return S.send(res, 200, { ok: true, out });
};
