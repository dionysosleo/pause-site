/* 기업 계정 공용: 진도 계산, 기업 상세(운영자·담당자 화면 공통), 배정·회수 */
const S = require('./_sb.js');
const enc = encodeURIComponent;
async function get(path) { const r = await S.rest('GET', path); if (!r.ok) throw new Error('DB ' + r.status + ' ' + r.text); return r.data || []; }
async function write(method, path, body, prefer) { const r = await S.rest(method, path, body, prefer || 'return=representation'); if (!r.ok) throw new Error('DB ' + r.status + ' ' + r.text); return r.data; }

/* 강의별 진도율(맛보기 제외). 기업에는 진도율·수료 여부만 보여 줌(질문·실습 내용은 안 줌) */
async function progressFor(userIds, courseIds) {
  if (!userIds.length || !courseIds.length) return {};
  const ls = await get('lessons?select=id,course_id&is_free=eq.false&course_id=in.(' + courseIds.map(enc).join(',') + ')');
  const pr = ls.length ? await get('progress?select=user_id,lesson_id&completed_at=not.is.null&user_id=in.(' + userIds.join(',') + ')&lesson_id=in.(' + ls.map(l => l.id).join(',') + ')') : [];
  const per = {}, byL = {}, done = {}, out = {};
  ls.forEach(l => { per[l.course_id] = (per[l.course_id] || 0) + 1; byL[l.id] = l.course_id; });
  pr.forEach(p => { const k = p.user_id + '|' + byL[p.lesson_id]; done[k] = (done[k] || 0) + 1; });
  userIds.forEach(u => courseIds.forEach(c => { const tot = per[c] || 0, d = done[u + '|' + c] || 0; out[u + '|' + c] = { pct: tot ? Math.round(100 * d / tot) : 0, done: tot > 0 && d >= tot }; }));
  return out;
}

async function detail(id) {
  const [c] = await get('companies?select=id,name,biz_no,created_at&id=eq.' + id);
  if (!c) return { company: null };
  const admins = await get('company_admins?select=user_id&company_id=eq.' + id);
  const ap = admins.length ? await get('profiles?select=id,name,email&id=in.(' + admins.map(a => a.user_id).join(',') + ')') : [];
  const seats = await get('company_seats?select=id,course_id,total,expires_at,order_id,created_at&company_id=eq.' + id + '&order=created_at.desc');
  const members = await get('company_members?select=id,email,name,dept,user_id,status,invited_at,joined_at&company_id=eq.' + id + '&status=neq.removed&order=invited_at.desc');
  const asg = members.length ? await get('company_assignments?select=id,member_id,seat_id&revoked_at=is.null&member_id=in.(' + members.map(m => m.id).join(',') + ')') : [];
  const users = members.filter(m => m.user_id).map(m => m.user_id);
  const pr = await progressFor(users, [...new Set(seats.map(s => s.course_id))]);
  return {
    company: c, admins: ap,
    seats: seats.map(s => Object.assign(s, { used: asg.filter(a => a.seat_id === s.id).length })),
    members: members.map(m => Object.assign(m, { assigned: asg.filter(a => a.member_id === m.id).map(a => { const s = seats.find(x => x.id === a.seat_id) || {}; return Object.assign({ seat_id: a.seat_id, course_id: s.course_id }, m.user_id ? pr[m.user_id + '|' + s.course_id] || {} : {}); }) }))
  };
}

async function invite(companyId, list) {
  const rows = [];
  for (const x of list.slice(0, 300)) {
    const email = String(x.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    rows.push({ company_id: companyId, email, name: String(x.name || '').trim().slice(0, 40), dept: String(x.dept || '').trim().slice(0, 40), status: 'invited' });
  }
  if (!rows.length) return { added: 0 };
  /* 이미 있으면(빠졌던 사람 포함) 다시 초대 상태로 */
  const ex = await get('company_members?select=id,email,status&company_id=eq.' + companyId + '&email=in.(' + rows.map(r => '"' + r.email + '"').join(',') + ')');
  const fresh = rows.filter(r => !ex.some(e => e.email.toLowerCase() === r.email));
  if (fresh.length) await write('POST', 'company_members', fresh, 'return=minimal');
  const back = ex.filter(e => e.status === 'removed');
  for (const e of back) await write('PATCH', 'company_members?id=eq.' + e.id, { status: 'invited', user_id: null, joined_at: null }, 'return=minimal');
  return { added: fresh.length + back.length, existed: ex.length - back.length };
}

async function assign(companyId, memberId, seatId) {
  const [m] = await get('company_members?select=id,user_id,status&company_id=eq.' + companyId + '&id=eq.' + memberId);
  const [s] = await get('company_seats?select=id,course_id,total,expires_at&company_id=eq.' + companyId + '&id=eq.' + seatId);
  if (!m || m.status === 'removed' || !s) throw new Error('BAD_REQUEST');
  if (s.expires_at && s.expires_at < new Date().toISOString()) throw new Error('SEAT_EXPIRED');
  const used = await get('company_assignments?select=id,member_id&revoked_at=is.null&seat_id=eq.' + s.id);
  if (used.some(a => a.member_id === m.id)) return { ok: true };
  if (used.length >= s.total) throw new Error('NO_SEATS');
  const prev = await get('company_assignments?select=id&member_id=eq.' + m.id + '&seat_id=eq.' + s.id);
  if (prev.length) await write('PATCH', 'company_assignments?id=eq.' + prev[0].id, { revoked_at: null, assigned_at: new Date().toISOString() }, 'return=minimal');
  else await write('POST', 'company_assignments', { member_id: m.id, seat_id: s.id }, 'return=minimal');
  if (m.user_id && m.status === 'active') {
    const ex = await get('enrollments?select=id&revoked_at=is.null&user_id=eq.' + m.user_id + '&seat_id=eq.' + s.id);
    if (!ex.length) await write('POST', 'enrollments', { user_id: m.user_id, course_id: s.course_id, source: 'company', seat_id: s.id }, 'return=minimal');
  }
  return { ok: true };
}

async function unassign(companyId, memberId, seatId) {
  const [m] = await get('company_members?select=id,user_id&company_id=eq.' + companyId + '&id=eq.' + memberId);
  const [s] = await get('company_seats?select=id&company_id=eq.' + companyId + '&id=eq.' + seatId);
  if (!m || !s) throw new Error('BAD_REQUEST');
  const now = new Date().toISOString();
  await write('PATCH', 'company_assignments?member_id=eq.' + m.id + '&seat_id=eq.' + s.id + '&revoked_at=is.null', { revoked_at: now }, 'return=minimal');
  if (m.user_id) await write('PATCH', 'enrollments?user_id=eq.' + m.user_id + '&seat_id=eq.' + s.id + '&revoked_at=is.null', { revoked_at: now }, 'return=minimal');
  return { ok: true };
}

async function removeMember(companyId, memberId) {
  const d = await detail(companyId);
  const m = (d.members || []).find(x => x.id === memberId); if (!m) throw new Error('BAD_REQUEST');
  for (const a of m.assigned) await unassign(companyId, memberId, a.seat_id);
  await write('PATCH', 'company_members?id=eq.' + memberId, { status: 'removed' }, 'return=minimal');
  return { ok: true };
}

module.exports = { progressFor, detail, invite, assign, unassign, removeMember, get };
