/* 데이터 백업: 주요 표를 JSON(gzip)으로 묶어 비공개 저장소 'backups'에 올림. 최근 8개만 보관.
   무료 플랜용 안전장치예요. 같은 Supabase 안에 있으니, 프로젝트 자체 사고에 대비하려면 관리자 화면에서 내려받아 따로 보관하세요. */
const zlib = require('zlib');
const S = require('./_sb.js');
const TABLES = ['profiles', 'consents', 'orders', 'enrollments', 'progress', 'courses', 'lessons', 'lesson_media', 'kit_files', 'kit_downloads', 'companies', 'company_admins', 'company_seats', 'company_members', 'company_assignments', 'coupons', 'leads', 'admins', 'admin_logs'];
const KEEP = 8;
async function all(t) {
  const out = []; let from = 0;
  for (let i = 0; i < 50; i++) {
    const r = await S.rest('GET', t + '?select=*&limit=1000&offset=' + from);
    if (!r.ok) return { error: r.status + ' ' + r.text };
    out.push(...r.data); if (r.data.length < 1000) break; from += 1000;
  }
  return out;
}
async function run(reason) {
  const data = { made_at: new Date().toISOString(), reason: reason || 'weekly', tables: {} };
  for (const t of TABLES) data.tables[t] = await all(t);
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const name = 'chaand-' + data.made_at.replace(/[:.]/g, '-').slice(0, 19) + '.json.gz';
  const k = process.env.SUPABASE_SECRET_KEY;
  const r = await fetch('https://mryawowqarptvtpxcwxl.supabase.co/storage/v1/object/backups/' + name, { method: 'POST', headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/gzip' }, body: buf });
  if (!r.ok) throw new Error('backup upload ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const ls = await list();
  const old = ls.slice(KEEP).map(x => x.name);
  if (old.length) await S.storage('DELETE', 'object/backups', { prefixes: old });
  return { name, bytes: buf.length, rows: Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, Array.isArray(v) ? v.length : -1])) };
}
async function list() {
  const r = await S.storage('POST', 'object/list/backups', { prefix: '', limit: 100, sortBy: { column: 'name', order: 'desc' } });
  return (r.ok && Array.isArray(r.data) ? r.data : []).filter(x => /\.json\.gz$/.test(x.name)).map(x => ({ name: x.name, size: x.metadata && x.metadata.size, at: x.created_at }));
}
module.exports = { run, list };
