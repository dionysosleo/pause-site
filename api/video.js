/* 강의 재생 주소 발급: GET ?lesson=편번호  (헤더 X-Device: 브라우저 기기 번호)
   - 맛보기 편: 누구나 (오픈된 강의만)
   - 그 밖: 로그인 + 이용 중인 수강권 + 강의가 열려 있어야 함 (운영자는 예외)
   - 기기는 4대까지 (약관 제7조). 5번째 기기는 DEVICE_LIMIT
   - Bunny가 아직 연결 전이거나 영상이 없으면 pending */
const S = require('./_sb.js');
const B = require('./_bunny.js');
module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  try {
    const id = Number(req.query && req.query.lesson);
    if (!(id > 0)) return S.send(res, 400, { ok: false, code: 'BAD_REQUEST' });
    const [l] = (await S.rest('GET', 'lessons?select=id,course_id,is_free,title&id=eq.' + id)).data || [];
    if (!l) return S.send(res, 404, { ok: false, code: 'NO_LESSON' });
    const [c] = (await S.rest('GET', 'courses?select=id,is_open&id=eq.' + encodeURIComponent(l.course_id))).data || [];
    const u = await S.user(S.bearer(req));
    const admin = u ? await S.isAdminStrict(u, S.bearer(req)) : false;
    if (!admin) {
      if (!c || !c.is_open) return S.send(res, 403, { ok: false, code: 'NOT_OPEN' });
      if (!l.is_free) {
        if (!u) return S.send(res, 401, { ok: false, code: 'AUTH' });
        const en = (await S.rest('GET', 'enrollments?select=id,ends_at&revoked_at=is.null&user_id=eq.' + u.id + '&course_id=eq.' + encodeURIComponent(l.course_id))).data || [];
        if (!en.some(e => !e.ends_at || e.ends_at > new Date().toISOString())) return S.send(res, 403, { ok: false, code: 'NO_ACCESS' });
      }
    }
    if (u && !admin) {
      const dev = String(req.headers['x-device'] || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
      if (!dev) return S.send(res, 400, { ok: false, code: 'NO_DEVICE' });
      const label = String(req.headers['user-agent'] || '').replace(/[^\x20-\x7E]/g, '').slice(0, 120);
      const ex = (await S.rest('GET', 'devices?select=device_id&user_id=eq.' + u.id)).data || [];
      if (ex.some(d => d.device_id === dev)) await S.rest('PATCH', 'devices?user_id=eq.' + u.id + '&device_id=eq.' + dev, { last_seen: new Date().toISOString() }, 'return=minimal');
      else {
        if (ex.length >= 4) return S.send(res, 409, { ok: false, code: 'DEVICE_LIMIT' });
        await S.rest('POST', 'devices', { user_id: u.id, device_id: dev, label }, 'return=minimal');
      }
    }
    const [m] = (await S.rest('GET', 'lesson_media?select=provider,video_id&lesson_id=eq.' + id)).data || [];
    if (!m || !m.video_id || !B.configured()) return S.send(res, 200, { ok: true, pending: true });
    const e = B.embedUrl(m.video_id);
    return S.send(res, 200, { ok: true, url: e.url, expires: e.expires, watermark: u ? u.email : '' });
  } catch (err) { console.error('video', err && err.message); return S.send(res, 500, { ok: false, code: 'SERVER' }); }
};
