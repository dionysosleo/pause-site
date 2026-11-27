/* 운영자 알림: 같은 일(kind+ref)은 한 번만 보냄 (ops_alerts 에 기록) */
const S = require('./_sb.js');
const MAIL = require('./_mail.js');
const won = n => Number(n || 0).toLocaleString('ko-KR') + '원';
async function alert(kind, ref, subject, lines, link) {
  try {
    const r = await S.rest('POST', 'ops_alerts?on_conflict=kind,ref', { kind, ref: ref ? String(ref).slice(0, 120) : null }, 'resolution=ignore-duplicates,return=representation');
    if (r.ok && Array.isArray(r.data) && !r.data.length) return { dup: true };   // 이미 보낸 알림
    const m = await MAIL.ops(subject, lines, link);
    if (m.sent && r.ok && r.data[0]) await S.rest('PATCH', 'ops_alerts?id=eq.' + r.data[0].id, { sent: true }, 'return=minimal');
    return m;
  } catch (e) { console.error('ops alert', e && e.message); return { sent: false }; }
}
module.exports = { alert, won };
