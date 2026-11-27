/* 회원용 작은 기능 모음 (Vercel 함수 수를 아끼려고 한 파일에)
   GET  ?r=health            → 상태 점검 (공개, 장애 감시용): DB·PG·메일·예약 작업
   GET  ?r=kits              → 내가 받을 수 있는 파일 키트 목록
   GET  ?r=kit&id=           → 키트 내려받기 (2분짜리 서명된 주소) + 내려받기 기록(환불 계산 기준)
   POST {action:'ping'}      → 접속 기록 (IP·일시, 1년 보관 — 개인정보처리방침)
   POST {action:'ship', …}   → 차 키트 배송지 입력·수정 (본인 주문, 발송 전까지) */
const S = require('./_sb.js');
const PG = require('./_pg');
const MAIL = require('./_mail.js');
const CATALOG = require('../shop/catalog.json').items;

async function health() {
  const out = { ok: true, at: new Date().toISOString() };
  try { const r = await S.rest('GET', 'courses?select=id&limit=1'); out.db = r.ok; } catch (e) { out.db = false; }
  out.pg = await PG.health();
  out.mail = MAIL.ready();
  try { const r = await S.rest('GET', 'ops_alerts?select=at&kind=eq.cron_run&order=at.desc&limit=1'); const t = r.ok && r.data[0] ? Date.parse(r.data[0].at) : 0; out.cron = t > Date.now() - 30 * 3600e3; } catch (e) { out.cron = false; }
  out.ok = out.db && out.pg;   // 사이트가 돈을 받을 수 있는지 (메일·예약 작업은 참고용)
  return out;
}

/* 이 회원이 받을 수 있는 키트의 강의 목록: 수강 중인 강의 + 키트만 산 주문 */
async function kitCourses(u) {
  const [en, os] = await Promise.all([
    S.rest('GET', 'enrollments?select=course_id,ends_at&revoked_at=is.null&user_id=eq.' + u.id),
    S.rest('GET', 'orders?select=item_id,paid_at&status=in.(paid,partial_refunded)&user_id=eq.' + u.id)
  ]);
  const set = {};
  (en.ok ? en.data : []).forEach(e => { if (!e.ends_at || Date.parse(e.ends_at) > Date.now()) set[e.course_id] = { via: 'course' }; });
  (os.ok ? os.data : []).forEach(o => { const it = CATALOG[o.item_id]; if (it && it.kit && !set[it.kit]) set[it.kit] = { via: 'kit', paidAt: o.paid_at, item: o.item_id }; });
  return set;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  try {
    if (req.method === 'GET' && q.r === 'health') { const h = await health(); return S.send(res, h.ok ? 200 : 503, h); }
    if (req.method === 'POST' && !S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
    const u = await S.user(S.bearer(req));
    if (!u) return S.send(res, 401, { ok: false, code: 'AUTH' });

    if (req.method === 'GET' && q.r === 'kits') {
      const cs = await kitCourses(u), ids = Object.keys(cs);
      if (!ids.length) return S.send(res, 200, { ok: true, kits: [] });
      const [kf, open] = await Promise.all([
        S.rest('GET', 'kit_files?select=id,course_id,title,file_name,size_b,sort&course_id=in.(' + ids.map(encodeURIComponent).join(',') + ')&order=course_id,sort,id'),
        S.rest('GET', 'courses?select=id,is_open&id=in.(' + ids.map(encodeURIComponent).join(',') + ')')
      ]);
      const isOpen = {}; (open.ok ? open.data : []).forEach(c => { isOpen[c.id] = c.is_open; });
      const list = (kf.ok ? kf.data : []).filter(k => cs[k.course_id].via === 'kit' || isOpen[k.course_id]);
      const dl = list.length ? await S.rest('GET', 'kit_downloads?select=kit_id,first_at&user_id=eq.' + u.id + '&kit_id=in.(' + list.map(k => k.id).join(',') + ')') : { ok: true, data: [] };
      const got = {}; (dl.ok ? dl.data : []).forEach(d => { got[d.kit_id] = d.first_at; });
      return S.send(res, 200, { ok: true, kits: list.map(k => Object.assign(k, { via: cs[k.course_id].via, downloaded: got[k.id] || null })) });
    }
    if (req.method === 'GET' && q.r === 'kit') {
      const id = parseInt(q.id, 10); if (!(id > 0)) return S.send(res, 400, { ok: false, code: 'BAD_REQUEST' });
      const r = await S.rest('GET', 'kit_files?select=id,course_id,title,file_name,storage_path&id=eq.' + id);
      const k = r.ok && r.data[0]; if (!k) return S.send(res, 404, { ok: false, code: 'NO_KIT' });
      const cs = await kitCourses(u);
      if (!cs[k.course_id]) return S.send(res, 403, { ok: false, code: 'NO_ACCESS' });
      if (cs[k.course_id].via === 'course') { const c = await S.rest('GET', 'courses?select=is_open&id=eq.' + encodeURIComponent(k.course_id)); if (!(c.ok && c.data[0] && c.data[0].is_open)) return S.send(res, 409, { ok: false, code: 'NOT_OPEN' }); }
      const url = await S.signedGet('kits', k.storage_path, 120, k.file_name || k.title);
      if (!url) return S.send(res, 500, { ok: false, code: 'STORAGE' });
      await S.rest('POST', 'kit_downloads?on_conflict=user_id,kit_id', { user_id: u.id, kit_id: k.id }, 'resolution=ignore-duplicates,return=minimal');
      await S.rest('POST', 'access_logs', { user_id: u.id, ip: S.ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 200), kind: 'kit' }, 'return=minimal');
      return S.send(res, 200, { ok: true, url });
    }
    const b = req.method === 'POST' ? (await S.readJson(req) || {}) : {};
    if (b.action === 'ping') {
      /* 같은 회원은 30분에 한 번만 남김 */
      const last = await S.rest('GET', 'access_logs?select=at&user_id=eq.' + u.id + '&order=at.desc&limit=1');
      if (!(last.ok && last.data[0] && Date.parse(last.data[0].at) > Date.now() - 30 * 60e3))
        await S.rest('POST', 'access_logs', { user_id: u.id, ip: S.ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 200), kind: String(b.kind || 'visit').slice(0, 20) }, 'return=minimal');
      return S.send(res, 200, { ok: true });
    }
    if (b.action === 'ship') {
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
    }
    return S.send(res, 400, { ok: false, code: 'BAD_REQUEST' });
  } catch (e) { console.error('me', e && e.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
