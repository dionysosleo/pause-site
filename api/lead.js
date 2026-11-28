/* 문의·제안서 요청·오픈 알림·사전 진단 접수
   1) 우리 DB(leads)에 저장 → 관리자 화면 '문의 접수함'에서 상태 관리
   2) 같은 내용을 구글 시트(Apps Script)에도 보냄 → 시트에서도 보고, 운영자 알림 메일은 시트 쪽이 보냄
   둘 중 하나라도 저장되면 'ok'. 둘 다 1년 지나면 자동 삭제 (개인정보처리방침).
   Vercel 환경 변수: LEADS_SHEET_URL(Apps Script 웹 앱 주소, 없으면 아래 기본값), LEADS_SECRET(시트 상태 변경용 비밀 값) */
const S = require('./_sb.js');
const OPS = require('./_ops.js');
const MAIL = require('./_mail.js');
const SHEET = process.env.LEADS_SHEET_URL || 'https://script.google.com/macros/s/AKfycbznjt7abxus2cE7sAse9CBHc6JzKfrYzUArrwLGUFwMfaYk4YkSanxEbp8voRDcYoaPbA/exec';
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 2000);
const TOP = ['at', 'kind', 'company', 'name', 'email', 'phone', 'page', 'website', 'channel', 'type'];

async function toSheet(payload) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(SHEET, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', signal: ctl.signal });
    return r.ok && (await r.text()).trim() === 'ok';
  } catch (e) { return false; } finally { clearTimeout(t); }
}
module.exports = async (req, res) => {
  const out = (code, s) => { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.status(code).end(s); };
  if (req.method !== 'POST') return out(405, 'method');
  if (!S.sameOrigin(req)) return out(403, 'origin');
  const d = await S.readJson(req, 40000);
  if (!d || typeof d !== 'object') return out(400, 'bad');
  /* 전환 이벤트 (익명): {ev, path, item} — 개인정보 없이 이름·경로·상품만 남김 */
  if (d.ev) {
    const EV = ['quote_click', 'quote_pdf', 'buy_click', 'checkout_view', 'pay_done', 'lead_submit', 'proposal_submit', 'notify_submit', 'review_submit'];
    if (!EV.includes(d.ev)) return out(400, 'bad');
    try { await S.rest('POST', 'events', { name: d.ev, path: clip(d.path, 200).replace(/[?#].*$/, '') || null, item: clip(d.item, 60) || null }, 'return=minimal'); } catch (e) {}
    return out(200, 'ok');
  }
  /* 후기 폼: 비공개로 저장 → 관리자가 확인하고 공개 (동의한 것만 공개 가능) */
  if (d.review === true) {
    if (d.website) return out(200, 'ok');
    const quote = clip(d.quote, 400); if (quote.length < 5) return out(400, 'bad');
    const t = v => clip(v, 80) || null;
    try {
      const r = await S.rest('POST', 'testimonials', { quote, name: t(d.name), role: t(d.role), company: t(d.company), program: t(d.program), consent: d.consent === true, published: false, source: 'form' }, 'return=minimal');
      if (!r.ok) { console.error('review insert', r.status, r.text); return out(502, 'fail'); }
      await S.rest('POST', 'events', { name: 'review_submit', path: '/review', item: clip(d.item, 60) || null }, 'return=minimal');
      await OPS.alert('review_new', String(Date.now()), '새 후기가 들어왔어요 (공개 전)', [['프로그램', d.program || '-'], ['이름', d.name || '-'], ['공개 동의', d.consent === true ? '예' : '아니요']], '/admin#voices');
    } catch (e) { return out(502, 'fail'); }
    return out(200, 'ok');
  }
  if (d.website) return out(200, 'ok');                                   // 스팸 방지 칸이 채워지면 저장하지 않음
  const email = clip(d.email, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return out(400, 'bad');
  const kind = clip(d.kind, 60) || '문의';
  const detail = {}; Object.keys(d).forEach(k => { if (k.charAt(0) !== '_' && !TOP.includes(k) && d[k] !== '' && d[k] != null && /^[a-zA-Z_]{1,30}$/.test(k)) detail[k] = clip(d[k], 1500); });
  let id = null;
  try {
    /* 같은 이메일·종류로 1분 안에 다시 들어오면 한 건으로 봄 (두 번 누름 방지) */
    const dup = await S.rest('GET', 'leads?select=id&email=eq.' + encodeURIComponent(email) + '&kind=eq.' + encodeURIComponent(kind) + '&created_at=gt.' + encodeURIComponent(new Date(Date.now() - 60e3).toISOString()));
    if (dup.ok && dup.data.length) return out(200, 'ok');
    const est = parseInt(String(d.estimate || '').replace(/[^0-9]/g, ''), 10);
    const r = await S.rest('POST', 'leads', { amount: est > 0 && est < 1e10 ? est : null, kind, company: clip(d.company, 120) || null, name: clip(d.name, 80) || null, email, phone: clip(d.phone, 40).replace(/[^0-9+]/g, '') || null, page: clip(d.page, 300) || null, detail }, 'return=representation');
    if (r.ok && r.data[0]) id = r.data[0].id; else console.error('lead insert', r.status, r.text);
  } catch (e) { console.error('lead db', e && e.message); }
  const pub = {}; Object.keys(d).forEach(k => { if (k.charAt(0) !== '_') pub[k] = d[k]; });
  const sheetOk = await toSheet(Object.assign(pub, { email, id: id ? 'L' + id : '' }));
  if (id && sheetOk) await S.rest('PATCH', 'leads?id=eq.' + id, { sheet_ok: true }, 'return=minimal');
  if (id && !sheetOk && kind !== '사전 진단') await OPS.alert('lead_sheet_fail', 'L' + id, '새 접수 (시트 저장 실패, 관리자 화면에는 있어요) · ' + kind, [['회사', d.company || '-'], ['이름', d.name || '-'], ['이메일', email]], '/admin#leads');
  /* 받은 사람에게 접수 확인 메일 (메일 서버가 연결돼 있을 때만, 실패해도 접수는 그대로) */
  if ((id || sheetOk) && MAIL.ready() && (kind === '워크샵 문의' || kind === '제안서 요청')) {
    try { await MAIL.leadAck({ email, kind, name: clip(d.name, 80), company: clip(d.company, 120), program: clip(d.program, 120), size: clip(d.size, 20), when: clip(d.when, 60), estimate: clip(d.estimate, 30), proposalUrl: process.env.PROPOSAL_URL || '' }); } catch (e) { console.error('lead ack', e && e.message); }
  }
  return (id || sheetOk) ? out(200, 'ok') : out(502, 'fail');
};
