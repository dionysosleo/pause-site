/* 관리자 화면(/admin) 서버 — admins 표에 있는 운영자만.
   GET  ?r=dashboard | orders | members | member&id= | companies | company&id= | courses | shipments
   POST {action: refund | grant | revoke | company_create | company_admin | seat_add | course_open | lesson_save | lesson_delete | shipped}
   모든 쓰기는 여기서 서버 키로만 하고, 회원 화면에서는 이 표들을 직접 못 바꿔요. */
const S = require('../_sb.js');
const T = require('../_toss.js');
const CATALOG = require('../../shop/catalog.json').items;
const B = require('../_bunny.js');
const W = require('../payments/webhook.js');
const FF = require('../_fulfill.js');
/* 상품 분야: 카탈로그 환불 기준 문구로 나눔 */
const catOf = id => { const r = String((CATALOG[id] || {}).refund || ''); return /기업/.test(r) ? 'biz' : /살롱|원데이/.test(r) ? 'salon' : /기수|라이브|정기/.test(r) ? 'cohort' : /VOD/.test(r) ? 'vod' : 'etc'; };

const enc = encodeURIComponent;
const isKitItem = id => /차 키트/.test(String((CATALOG[id] || {}).note || ''));
const uuid = v => /^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : '';
const int = v => (Number.isInteger(Number(v)) ? Number(v) : NaN);
async function get(path) { const r = await S.rest('GET', path); if (!r.ok) throw new Error('DB ' + r.status + ' ' + r.text); return r.data || []; }
async function write(method, path, body, prefer) { const r = await S.rest(method, path, body, prefer || 'return=representation'); if (!r.ok) throw new Error('DB ' + r.status + ' ' + r.text); return r.data; }

const C = require('../_company.js');
const progressFor = C.progressFor;

const READ = {
  async logs(q) {
    let f = 'admin_logs?select=id,email,action,target,detail,created_at&order=created_at.desc&limit=300';
    const a = String(q.action || ''); if (/^[a-z_]{2,30}$/.test(a)) f += '&action=eq.' + a;
    return { logs: await get(f) };
  },
  async orders_csv() {
    return { orders: await get('orders?select=id,paid_at,item_id,qty,amount,refund_amount,status,is_test,buyer_name,buyer_email,method,source,tax_doc,memo,refunded_at,refund_reason&status=neq.ready&order=paid_at.desc&limit=5000') };
  },
  /* 대시보드: 기간별(일·주·월·년) 집계는 화면에서 함. 여기서는 필요한 칸만 가볍게 내려줌 */
  async dashboard() {
    const [os, ps, en, pr] = await Promise.all([
      get('orders?select=id,item_id,qty,amount,refund_amount,status,is_test,method,source,paid_at,refunded_at,refund_requested_at,shipped_at,ship_addr,buyer_name,buyer_email,user_id,due_at&status=neq.ready&order=created_at.desc&limit=10000'),
      get('profiles?select=id,name,email,login_method,marketing_ok,created_at&order=created_at.desc&limit=20000'),
      get('enrollments?select=user_id,course_id,source,started_at,revoked_at&limit=20000'),
      get('progress?select=user_id,updated_at,completed_at&order=updated_at.desc&limit=50000')
    ]);
    const live = o => o.status === 'paid' || o.status === 'partial_refunded';
    return {
      orders: os.map(o => ({ id: o.id, item: o.item_id, cat: catOf(o.item_id), src: o.source, qty: o.qty, amount: o.amount, refund: o.refund_amount || 0, status: o.status, test: !!o.is_test, method: o.method, paid: o.paid_at, refunded: o.refunded_at, name: o.buyer_name, email: o.buyer_email, member: !!o.user_id })),
      members: ps.map(p => ({ id: p.id, name: p.name, email: p.email, via: p.login_method, mk: !!p.marketing_ok, at: p.created_at })),
      enrollments: en.map(e => ({ u: e.user_id, c: e.course_id, src: e.source, at: e.started_at, off: !!e.revoked_at })),
      progress: pr.map(x => ({ u: x.user_id, at: x.updated_at, done: x.completed_at })),
      todo: {
        refunds: os.filter(o => o.refund_requested_at && o.status === 'paid').length,
        ship: os.filter(o => isKitItem(o.item_id) && live(o) && !o.shipped_at).length,
        shipNoAddr: os.filter(o => isKitItem(o.item_id) && live(o) && !o.shipped_at && !o.ship_addr).length,
        waiting: os.filter(o => o.status === 'waiting').length
      }
    };
  },
  async orders(q) {
    let f = 'orders?select=id,item_id,qty,amount,refund_amount,status,is_test,buyer_email,buyer_name,paid_at,user_id,refund_requested_at,refund_request_note,refund_reason,shipped_at,method,source,memo,tax_doc,vbank,due_at,created_at&status=neq.ready&order=created_at.desc&limit=200';
    if (q.status === 'requested') f += '&refund_requested_at=not.is.null&status=eq.paid';
    else if (q.status === 'manual') f += '&source=eq.manual';
    else if (['waiting', 'paid', 'partial_refunded', 'refunded', 'expired'].includes(q.status)) f += '&status=eq.' + q.status;
    if (q.test === '0') f += '&is_test=eq.false';
    const s = String(q.q || '').trim().slice(0, 80).replace(/[,()*]/g, '');
    if (s) f += '&or=(buyer_email.ilike.*' + enc(s) + '*,id.ilike.*' + enc(s) + '*,buyer_name.ilike.*' + enc(s) + '*)';
    return { orders: await get(f) };
  },
  async members(q) {
    let f = 'profiles?select=id,name,email,login_method,marketing_ok,created_at&order=created_at.desc&limit=200';
    const s = String(q.q || '').trim().slice(0, 80).replace(/[,()*]/g, '');
    if (s) f += '&or=(email.ilike.*' + enc(s) + '*,name.ilike.*' + enc(s) + '*)';
    const ms = await get(f);
    const en = ms.length ? await get('enrollments?select=user_id&revoked_at=is.null&user_id=in.(' + ms.map(m => m.id).join(',') + ')') : [];
    const cnt = {}; en.forEach(e => { cnt[e.user_id] = (cnt[e.user_id] || 0) + 1; });
    const ad = await get('admins?select=user_id');
    return { members: ms.map(m => Object.assign(m, { courses: cnt[m.id] || 0, admin: ad.some(a => a.user_id === m.id) })) };
  },
  async member(q) {
    const id = uuid(q.id); if (!id) throw new Error('BAD_ID');
    const [p] = await get('profiles?select=id,name,email,login_method,marketing_ok,marketing_at,created_at&id=eq.' + id);
    if (!p) return { member: null };
    const en = await get('enrollments?select=id,course_id,source,started_at,revoked_at,order_id,seat_id&user_id=eq.' + id + '&order=started_at.desc');
    const os = await get('orders?select=id,item_id,amount,refund_amount,status,is_test,paid_at&user_id=eq.' + id + '&order=created_at.desc');
    const pr = await progressFor([id], [...new Set(en.map(e => e.course_id))]);
    return { member: p, enrollments: en.map(e => Object.assign(e, pr[id + '|' + e.course_id] || {})), orders: os };
  },
  async companies() {
    const cs = await get('companies?select=id,name,biz_no,created_at&order=created_at.desc');
    const seats = cs.length ? await get('company_seats?select=company_id,total&company_id=in.(' + cs.map(c => c.id).join(',') + ')') : [];
    const mem = cs.length ? await get('company_members?select=company_id,status&status=neq.removed&company_id=in.(' + cs.map(c => c.id).join(',') + ')') : [];
    return { companies: cs.map(c => Object.assign(c, { seats: seats.filter(s => s.company_id === c.id).reduce((a, s) => a + s.total, 0), members: mem.filter(m => m.company_id === c.id).length })) };
  },
  async company(q) { const id = uuid(q.id); if (!id) throw new Error('BAD_ID'); return C.detail(id); },
  async courses() {
    const [cs, ls, md, en] = await Promise.all([get('courses?select=id,title,is_open,opened_at&order=id'), get('lessons?select=id,course_id,part,sort,title,is_free,duration_s&order=course_id,sort'), get('lesson_media?select=lesson_id,provider,video_id,status'), get('enrollments?select=course_id&revoked_at=is.null')]);
    return { bunny: B.configured(), courses: cs.map(c => Object.assign(c, { students: en.filter(e => e.course_id === c.id).length, lessons: ls.filter(l => l.course_id === c.id).map(l => Object.assign(l, { video_id: (md.find(m => m.lesson_id === l.id) || {}).video_id || '', video_status: (md.find(m => m.lesson_id === l.id) || {}).status })) })) };
  },
  async shipments() {
    const os = await get('orders?select=id,item_id,status,is_test,buyer_email,buyer_name,paid_at,ship_name,ship_phone,ship_addr,ship_memo,shipped_at,ship_tracking&status=in.(paid,partial_refunded)&order=created_at.desc&limit=300');
    return { orders: os.filter(o => isKitItem(o.item_id)) };
  }
};

const ACT = {
  async refund(b) {
    const orderId = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.orderId || '')) ? b.orderId : '';
    const amount = int(b.amount), reason = String(b.reason || '').trim().slice(0, 190);
    if (!orderId || !reason || !(amount > 0)) throw new Error('BAD_REQUEST');
    const [o] = await get('orders?select=id,amount,refund_amount,status,payment_key,method,source&id=eq.' + enc(orderId));
    if (!o || !['paid', 'partial_refunded'].includes(o.status)) throw new Error('NOT_REFUNDABLE');
    if (amount > o.amount - (o.refund_amount || 0)) throw new Error('TOO_MUCH');
    if (o.source !== 'manual') {   /* 직접 등록 거래는 돈을 따로 돌려준 뒤 기록만 */
      if (!o.payment_key) throw new Error('NOT_REFUNDABLE');
      /* 입금을 마친 가상계좌는 환불 받을 계좌가 필요함 (입금자 명의). 은행 코드·계좌번호·예금주는 저장하지 않고 이번 요청에만 씀 */
      let acct = null;
      if (o.method === '가상계좌') {
        const a = b.refundAccount || {};
        if (!/^\d{2,3}$/.test(String(a.bank || '')) || !/^\d{6,20}$/.test(String(a.number || '').replace(/-/g, '')) || !String(a.holder || '').trim()) throw new Error('VBANK_REFUND');
        acct = { bank: String(a.bank), accountNumber: String(a.number).replace(/-/g, ''), holderName: String(a.holder).trim().slice(0, 60) };
      }
      const c = await T.cancel(o.payment_key, amount, reason, orderId + '-cancel-' + ((o.refund_amount || 0) + amount), acct);
      if (!c.ok) { const e = new Error('PG'); e.pg = c.data; throw e; }
    }
    const st = await T.settle(S, o, amount, reason, b.revoke !== false);
    return { refunded: amount, total: st.total, full: st.full, revoked: st.revoked };
  },
  /* 결제창 밖 거래(기업 워크샵 계좌이체·세금계산서 등)를 매출에 넣기 */
  async order_manual(b) {
    const itemId = String(b.itemId || ''); if (!CATALOG[itemId]) throw new Error('BAD_REQUEST');
    const amount = int(b.amount), qty = Math.max(int(b.qty) || 1, 1);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 100), name = String(b.name || '').trim().slice(0, 80);
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidAt || '')) ? new Date(b.paidAt + 'T12:00:00+09:00').toISOString() : new Date().toISOString();
    const method = ['계좌이체', '세금계산서', '현금', '카드(단말기)', '기타'].includes(b.method) ? b.method : '계좌이체';
    const tax = ['none', 'tax_invoice', 'cash_receipt', 'card'].includes(b.taxDoc) ? b.taxDoc : 'none';
    if (!(amount > 0) || amount > 1e9 || !name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('BAD_REQUEST');
    const [p] = await get('profiles?select=id&email=ilike.' + enc(email));
    const id = 'M' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
    const row = { id, user_id: p ? p.id : null, buyer_email: email, buyer_name: name, item_id: itemId, qty, amount, method, status: 'paid', paid_at: paidAt, source: 'manual', tax_doc: tax, memo: String(b.memo || '').slice(0, 300) || null, grants_course: CATALOG[itemId].grants || null, is_test: false };
    await write('POST', 'orders', row);
    const f = await FF.fulfill(row, { mail: b.mail === true });
    return { id, member: !!p, enrolled: f.enrolled };
  },
  async order_memo(b) {
    const id = String(b.orderId || ''); if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('BAD_REQUEST');
    const tax = ['none', 'tax_invoice', 'cash_receipt', 'card'].includes(b.taxDoc) ? b.taxDoc : null;
    await write('PATCH', 'orders?id=eq.' + enc(id), Object.assign({ memo: String(b.memo || '').slice(0, 300) || null }, tax ? { tax_doc: tax } : {}));
    return {};
  },
  /* 입금 전 가상계좌 주문 취소 (돌려줄 돈이 없어 계좌 정보 없이 전액 취소만 가능) */
  async cancel_waiting(b) {
    const id = String(b.orderId || ''); if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('BAD_REQUEST');
    const [o] = await get('orders?select=id,amount,status,payment_key&id=eq.' + enc(id));
    if (!o || o.status !== 'waiting' || !o.payment_key) throw new Error('NOT_REFUNDABLE');
    const c = await T.cancel(o.payment_key, o.amount, String(b.reason || '입금 전 주문 취소').slice(0, 190), id + '-cancel-waiting');
    if (!c.ok) { const e = new Error('PG'); e.pg = c.data; throw e; }
    await write('PATCH', 'orders?id=eq.' + enc(id), { status: 'canceled', pg_synced_at: new Date().toISOString() });
    return {};
  },
  async pg_sync(b) {
    const id = String(b.orderId || ''); if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('BAD_REQUEST');
    return { result: await W.sync(id) };
  },
  async grant(b) {
    const uid = uuid(b.userId), course = String(b.courseId || '');
    if (!uid || !(await get('courses?select=id&id=eq.' + enc(course))).length) throw new Error('BAD_REQUEST');
    const ex = await get('enrollments?select=id&revoked_at=is.null&source=eq.grant&user_id=eq.' + uid + '&course_id=eq.' + enc(course));
    if (!ex.length) await write('POST', 'enrollments', { user_id: uid, course_id: course, source: 'grant' });
    return { granted: true };
  },
  async revoke(b) {
    const id = int(b.enrollmentId); if (!(id > 0)) throw new Error('BAD_REQUEST');
    await write('PATCH', 'enrollments?id=eq.' + id, { revoked_at: new Date().toISOString() });
    return { revoked: true };
  },
  async company_create(b) {
    const name = String(b.name || '').trim().slice(0, 80); if (!name) throw new Error('BAD_REQUEST');
    const r = await write('POST', 'companies', { name, biz_no: String(b.bizNo || '').replace(/[^0-9-]/g, '').slice(0, 20) || null });
    return { company: r && r[0] };
  },
  async company_admin(b) {
    const cid = uuid(b.companyId), email = String(b.email || '').trim().toLowerCase();
    if (!cid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('BAD_REQUEST');
    const [p] = await get('profiles?select=id&email=ilike.' + enc(email));
    if (!p) throw new Error('NO_MEMBER');   // 담당자는 먼저 회원 가입해야 함
    if (b.remove) await write('DELETE', 'company_admins?company_id=eq.' + cid + '&user_id=eq.' + p.id);
    else await write('POST', 'company_admins', { company_id: cid, user_id: p.id }, 'resolution=ignore-duplicates,return=minimal');
    return { ok: true };
  },
  async seat_add(b) {
    const cid = uuid(b.companyId), total = int(b.total), course = String(b.courseId || '');
    if (!cid || !(total > 0 && total <= 10000) || !(await get('courses?select=id&id=eq.' + enc(course))).length) throw new Error('BAD_REQUEST');
    const exp = b.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) ? new Date(b.expiresAt + 'T23:59:59+09:00').toISOString() : null;
    const r = await write('POST', 'company_seats', { company_id: cid, course_id: course, total, expires_at: exp, order_id: String(b.orderId || '').slice(0, 64) || null });
    return { seat: r && r[0] };
  },
  async company_invite(b) { const cid = uuid(b.companyId); if (!cid) throw new Error('BAD_REQUEST'); return C.invite(cid, Array.isArray(b.people) ? b.people : []); },
  async company_assign(b) { const cid = uuid(b.companyId); if (!cid) throw new Error('BAD_REQUEST'); return C.assign(cid, int(b.memberId), int(b.seatId)); },
  async company_unassign(b) { const cid = uuid(b.companyId); if (!cid) throw new Error('BAD_REQUEST'); return C.unassign(cid, int(b.memberId), int(b.seatId)); },
  async company_remove(b) { const cid = uuid(b.companyId); if (!cid) throw new Error('BAD_REQUEST'); return C.removeMember(cid, int(b.memberId)); },
  async course_open(b) {
    const id = String(b.courseId || ''); if (!(await get('courses?select=id&id=eq.' + enc(id))).length) throw new Error('BAD_REQUEST');
    await write('PATCH', 'courses?id=eq.' + enc(id), b.open ? { is_open: true, opened_at: new Date().toISOString() } : { is_open: false });
    if (b.open) await write('PATCH', 'enrollments?course_id=eq.' + enc(id) + '&revoked_at=is.null', { started_at: new Date().toISOString() });   // 사전 예약: 연 날이 수강 시작일
    return { ok: true };
  },
  async lesson_save(b) {
    const course = String(b.courseId || ''), title = String(b.title || '').trim().slice(0, 120), sort = int(b.sort);
    if (!course || !title || !(sort > 0)) throw new Error('BAD_REQUEST');
    const row = { course_id: course, part: String(b.part || '').trim().slice(0, 60), sort, title, is_free: !!b.isFree, duration_s: Math.max(0, int(b.durationS) || 0) };
    let id = int(b.id);
    if (id > 0) await write('PATCH', 'lessons?id=eq.' + id, row);
    else { const r = await write('POST', 'lessons', row); id = r[0].id; }
    const vid = String(b.videoId || '').trim().slice(0, 100);
    if (vid) await write('POST', 'lesson_media', { lesson_id: id, provider: 'bunny', video_id: vid }, 'resolution=merge-duplicates,return=minimal');
    else await write('DELETE', 'lesson_media?lesson_id=eq.' + id);
    return { id };
  },
  async lesson_delete(b) {
    const id = int(b.id); if (!(id > 0)) throw new Error('BAD_REQUEST');
    await write('DELETE', 'lessons?id=eq.' + id);
    return { ok: true };
  },
  async video_init(b) {
    if (!B.configured()) throw new Error('BUNNY_NOT_SET');
    return B.createUpload(String(b.title || 'lesson'));
  },
  async video_status(b) {
    if (!B.configured()) throw new Error('BUNNY_NOT_SET');
    const id = String(b.videoId || ''); if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw new Error('BAD_REQUEST');
    const st = await B.status(id);
    await write('PATCH', 'lesson_media?video_id=eq.' + enc(id), { status: st.status, length_s: st.length || null }, 'return=minimal');
    if (st.length) { const lm = await get('lesson_media?select=lesson_id&video_id=eq.' + enc(id)); for (const x of lm) await write('PATCH', 'lessons?id=eq.' + x.lesson_id + '&duration_s=eq.0', { duration_s: st.length }, 'return=minimal'); }
    return st;
  },
  async shipped(b) {
    const id = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.orderId || '')) ? b.orderId : ''; if (!id) throw new Error('BAD_REQUEST');
    await write('PATCH', 'orders?id=eq.' + enc(id), b.undo ? { shipped_at: null, ship_tracking: null } : { shipped_at: new Date().toISOString(), ship_tracking: String(b.tracking || '').trim().slice(0, 80) || null });
    return { ok: true };
  }
};

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return S.send(res, 405, { ok: false, code: 'METHOD' }); }
  if (req.method === 'POST' && !S.sameOrigin(req)) return S.send(res, 403, { ok: false, code: 'ORIGIN' });
  try {
    const tok = S.bearer(req), u = await S.user(tok);
    if (!(await S.isAdmin(u))) return S.send(res, 403, { ok: false, code: 'NOT_ADMIN' });
    if (req.method === 'GET' && (req.query || {}).r === 'me') return S.send(res, 200, { ok: true, admin: true, aal: S.aal(tok), mfa: S.mfaOn() });
    if (S.mfaOn() && S.aal(tok) !== 'aal2') return S.send(res, 403, { ok: false, code: 'MFA_REQUIRED' });   // 운영 작업은 2단계 인증 뒤에만
    if (req.method === 'GET') {
      const q = req.query || {}, fn = READ[q.r];
      if (!fn) return S.send(res, 400, { ok: false, code: 'BAD_RESOURCE' });
      return S.send(res, 200, Object.assign({ ok: true }, await fn(q)));
    }
    const b = await S.readJson(req) || {}, fn = ACT[b.action];
    if (!fn) return S.send(res, 400, { ok: false, code: 'BAD_ACTION' });
    const out = await fn(b);
    if (!/^video_status$/.test(b.action)) {
      const keep = Object.assign({}, b); delete keep.action;
      if (keep.refundAccount) keep.refundAccount = '(환불 계좌 받음, 저장 안 함)';
      await S.log(u, b.action, b.orderId || b.userId || b.enrollmentId || b.companyId || b.courseId || b.id || null, keep);
    }
    return S.send(res, 200, Object.assign({ ok: true }, out));
  } catch (e) {
    const m = String(e && e.message || '');
    if (e && e.pg) return S.send(res, 402, { ok: false, code: String(e.pg.code || 'PG_REJECTED').slice(0, 60), message: String(e.pg.message || '').slice(0, 200) });
    if (/^(BAD_REQUEST|BAD_ID|NOT_REFUNDABLE|TOO_MUCH|NO_MEMBER|NO_SEATS|SEAT_EXPIRED|BUNNY_NOT_SET)$/.test(m)) return S.send(res, 400, { ok: false, code: m });
    console.error('admin', m);
    return S.send(res, 500, { ok: false, code: 'SERVER' });
  }
};
