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
async function readJson(req, max) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > (max || 8192)) return null; chunks.push(c); }
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
/* 비공개 저장소(Storage): 서명된 내려받기·올리기 주소 */
async function storage(method, path, body) {
  const k = secret();
  const r = await fetch(URL_ + '/storage/v1/' + path, { method, headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, data, text: r.ok ? '' : txt.slice(0, 300) };
}
const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');
async function signedGet(bucket, path, sec, fileName) {
  const r = await storage('POST', 'object/sign/' + bucket + '/' + encPath(path), { expiresIn: sec || 120 });
  if (!r.ok || !r.data || !r.data.signedURL) return null;
  return URL_ + '/storage/v1' + r.data.signedURL + (fileName ? '&download=' + encodeURIComponent(fileName) : '');
}
async function signedPut(bucket, path) {
  const r = await storage('POST', 'object/upload/sign/' + bucket + '/' + encPath(path), {});
  if (!r.ok || !r.data || !r.data.url) return null;
  return URL_ + '/storage/v1' + r.data.url;
}
async function deleteAuthUser(id) {
  const k = secret();
  const r = await fetch(URL_ + '/auth/v1/admin/users/' + encodeURIComponent(id), { method: 'DELETE', headers: { apikey: k, Authorization: 'Bearer ' + k } });
  return { ok: r.ok, status: r.status, text: r.ok ? '' : (await r.text()).slice(0, 300) };
}
/* 운영자면 { perms } 를, 아니면 false. perms 에 'all' 이 있으면 전체 권한 */
async function isAdmin(u) {
  if (!u) return false;
  const r = await rest('GET', 'admins?select=user_id,perms,label&user_id=eq.' + encodeURIComponent(u.id));
  const a = r.ok && Array.isArray(r.data) && r.data[0];
  return a ? { perms: a.perms && a.perms.length ? a.perms : ['all'], label: a.label || '' } : false;
}
const can = (a, p) => !!a && (a.perms.includes('all') || a.perms.includes(p));
/* 접속한 곳의 IP (Vercel이 넣어 주는 헤더) */
function ip(req) { return String((req && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim().slice(0, 64) || null; }
/* 2단계 인증 여부: 토큰은 user()에서 Supabase가 이미 확인함. 여기서는 안의 aal 값만 읽음 */
function aal(token) {
  try { const p = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return p.aal || 'aal1'; } catch (e) { return 'aal1'; }
}
/* 2단계 인증은 선택: Vercel 환경 변수 ADMIN_MFA=on 일 때만 요구 (기본은 비밀번호 로그인만) */
function mfaOn() { return process.env.ADMIN_MFA === 'on'; }
async function isAdminStrict(u, token) { return (!mfaOn() || aal(token) === 'aal2') ? await isAdmin(u) : false; }
async function log(u, action, target, detail, ipAddr) {
  try { await rest('POST', 'admin_logs', { user_id: u && u.id, email: u && u.email, action, target: target ? String(target).slice(0, 120) : null, detail: detail || null, ip: ipAddr || null }, 'return=minimal'); } catch (e) { console.error('log', e && e.message); }
}
module.exports = { send, sameOrigin, bearer, readJson, user, rest, deleteAuthUser, isAdmin, isAdminStrict, can, ip, storage, signedGet, signedPut, aal, mfaOn, log };
