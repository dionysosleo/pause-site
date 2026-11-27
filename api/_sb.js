/* 서버 전용 Supabase 도우미. 비밀 키는 Vercel 환경 변수 SUPABASE_SECRET_KEY 에만 있음. */
const URL_ = 'https://mryawowqarptvtpxcwxl.supabase.co';
const PUBLIC = 'sb_publishable_wC2dVRAITr3Ta5AmIzWpKQ_WyOV0OER';
const ALLOWED_HOSTS = ['www.chaand.ai', 'chaand.ai'];

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).end(JSON.stringify(body));
}
function sameOrigin(req) {
  try { const h = new URL(req.headers.origin || '').host; return ALLOWED_HOSTS.includes(h) || h === req.headers.host; } catch (e) { return false; }
}
function bearer(req) { const a = String(req.headers.authorization || ''); return /^Bearer [A-Za-z0-9._-]{20,4096}$/.test(a) ? a.slice(7) : ''; }
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 8192) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return null; }
}
/* 로그인한 회원 확인 (토큰 → 회원 정보) */
async function user(token) {
  if (!token) return null;
  try {
    const r = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: PUBLIC, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null; const u = await r.json(); return u && u.id ? u : null;
  } catch (e) { return null; }
}
function secret() { const k = process.env.SUPABASE_SECRET_KEY; if (!k) throw new Error('NO_SECRET'); return k; }
/* 관리 권한(서버 키)으로 DB 읽기·쓰기 */
async function rest(method, path, body, prefer) {
  const k = secret();
  const r = await fetch(URL_ + '/rest/v1/' + path, {
    method, headers: Object.assign({ apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const txt = await r.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, data, text: r.ok ? '' : txt.slice(0, 300) };
}
async function deleteAuthUser(id) {
  const k = secret();
  const r = await fetch(URL_ + '/auth/v1/admin/users/' + encodeURIComponent(id), { method: 'DELETE', headers: { apikey: k, Authorization: 'Bearer ' + k } });
  return { ok: r.ok, status: r.status, text: r.ok ? '' : (await r.text()).slice(0, 300) };
}
async function isAdmin(u) {
  if (!u) return false;
  const r = await rest('GET', 'admins?select=user_id&user_id=eq.' + encodeURIComponent(u.id));
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}
/* 2단계 인증 여부: 토큰은 user()에서 Supabase가 이미 확인함. 여기서는 안의 aal 값만 읽음 */
function aal(token) {
  try { const p = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return p.aal || 'aal1'; } catch (e) { return 'aal1'; }
}
/* 운영자 권한은 2단계 인증(aal2)을 마친 세션에서만 */
async function isAdminStrict(u, token) { return aal(token) === 'aal2' && await isAdmin(u); }
async function log(u, action, target, detail) {
  try { await rest('POST', 'admin_logs', { user_id: u && u.id, email: u && u.email, action, target: target ? String(target).slice(0, 120) : null, detail: detail || null }, 'return=minimal'); } catch (e) { console.error('log', e && e.message); }
}
module.exports = { send, sameOrigin, bearer, readJson, user, rest, deleteAuthUser, isAdmin, isAdminStrict, aal, log };
