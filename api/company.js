/* 기업 담당자용: 내가 담당하는 회사의 수강권·구성원 관리 (company_admins에 있는 회원만)
   GET → 담당 회사 목록 + 첫 회사(또는 ?id=) 상세
   POST {action: invite | assign | unassign | remove, companyId, ...} */
const S = require('./_sb.js');
const C = require('./_company.js');
const uuid = v => /^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : '';
module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  if (req.method === 'POST' && !S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
  try {
    const u = await S.user(S.bearer(req));
    if (!u) return S.send(res, 401, { ok: false, code: 'AUTH' });
    const mine = await C.get('company_admins?select=company_id&user_id=eq.' + u.id);
    if (!mine.length) return S.send(res, 403, { ok: false, code: 'NOT_COMPANY_ADMIN' });
    const ids = mine.map(m => m.company_id);
    if (req.method === 'GET') {
      const list = await C.get('companies?select=id,name&id=in.(' + ids.join(',') + ')');
      const want = uuid(req.query && req.query.id);
      const d = await C.detail(want && ids.includes(want) ? want : ids[0]);
      return S.send(res, 200, Object.assign({ ok: true, list }, d));
    }
    const b = await S.readJson(req) || {};
    const cid = uuid(b.companyId);
    if (!cid || !ids.includes(cid)) return S.send(res, 403, { ok: false, code: 'NOT_COMPANY_ADMIN' });
    const mid = Number(b.memberId), sid = Number(b.seatId);
    let r;
    if (b.action === 'invite') r = await C.invite(cid, Array.isArray(b.people) ? b.people : []);
    else if (b.action === 'assign') r = await C.assign(cid, mid, sid);
    else if (b.action === 'unassign') r = await C.unassign(cid, mid, sid);
    else if (b.action === 'remove') r = await C.removeMember(cid, mid);
    else return S.send(res, 400, { ok: false, code: 'BAD_ACTION' });
    return S.send(res, 200, Object.assign({ ok: true }, r));
  } catch (e) {
    const m = String(e && e.message || '');
    if (/^(BAD_REQUEST|NO_SEATS|SEAT_EXPIRED)$/.test(m)) return S.send(res, 400, { ok: false, code: m });
    console.error('company', m); return S.send(res, 500, { ok: false, code: 'SERVER' });
  }
};
