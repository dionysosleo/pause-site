/* 관리자 화면(/admin) 서버 — admins 표에 있는 운영자만.
   GET  ?r=dashboard | orders | members | member&id= | companies | company&id= | courses | shipments
   POST {action: refund | grant | revoke | company_create | company_admin | seat_add | course_open | lesson_save | lesson_delete | shipped}
   모든 쓰기는 여기서 서버 키로만 하고, 회원 화면에서는 이 표들을 직접 못 바꿔요. */
const S = require('../_sb.js');
const T = require('../_cancel.js');
const CATALOG = require('../../shop/catalog.json').items;
const B = require('../_bunny.js');
const W = require('../payments/webhook.js');
const FF = require('../_fulfill.js');
const MAIL = require('../_mail.js');
const BK = require('../_backup.js');
const PGA = require('../_pg');
const PRICE = require('../_price.js');
const BR = require('../_brief.js');
/* 상품 분야: 카탈로그 환불 기준 문구로 나눔 */
const catOf = id => { const r = String((CATALOG[id] || {}).refund || ''); return /기업/.test(r) ? 'biz' : /살롱|원데이/.test(r) ? 'salon' : /기수|라이브|정기/.test(r) ? 'cohort' : /VOD/.test(r) ? 'vod' : 'etc'; };

const enc = encodeURIComponent;
const digits = v => String(v || '').replace(/[^0-9]/g, '');
const DATE = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const kstFrom = d => new Date(d + 'T00:00:00+09:00').toISOString();
const kstTo = d => new Date(Date.parse(d + 'T00:00:00+09:00') + 864e5).toISOString();
const tempPassword = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; const b = require('crypto').randomBytes(14); let s = ''; for (const x of b) s += c[x % c.length]; return s.slice(0, 4) + '-' + s.slice(4, 9) + '-' + s.slice(9, 14); };
const isKitItem = id => /차 키트/.test(String((CATALOG[id] || {}).note || ''));
const uuid = v => /^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : '';
const int = v => (Number.isInteger(Number(v)) ? Number(v) : NaN);
async function get(path) { const r = await S.rest('GET', path); if (!r.ok) throw new Error('DB ' + r.status + ' ' + r.text); return r.data || []; }
async function write(method, path, body, prefer) { const r = await S.rest(method, path, body, prefer || 'return=representation'); if (!r.ok) throw new Error('DB ' + r.status + ' ' + r.text); return r.data; }

const C = require('../_company.js');
const progressFor = C.progressFor;

/* 강의 오픈 알림: 수강권 있는 회원 + '오픈 알림' 신청자. 한 사람에게 한 번만 (ops_alerts 로 기록), 한 번에 150명까지 → 남으면 다시 누르면 이어서 */
async function notifyOpen(courseId) {
  const [c] = await get('courses?select=id,title&id=eq.' + enc(courseId));
  const it = CATALOG[courseId] || {}, names = [c && c.title, it.name].filter(Boolean).map(x => String(x).replace(/\s*\(.*?\)\s*/g, '').trim());
  const en = await get('enrollments?select=user_id&course_id=eq.' + enc(courseId) + '&revoked_at=is.null');
  const ps = en.length ? await get('profiles?select=email&id=in.(' + [...new Set(en.map(e => e.user_id))].join(',') + ')') : [];
  const ls = await get('leads?select=email,detail&kind=eq.' + enc('오픈 알림'));
  const subs = ls.filter(l => { const t = String((l.detail || {}).course || ''); return names.some(n => n && (t.includes(n) || n.includes(t.replace(/\s*\(.*?\)\s*/g, '').trim()))); });
  const list = [...ps.map(p => ({ email: p.email, buyer: true })), ...subs.map(l => ({ email: l.email, buyer: false }))];
  const seen = new Set(), todo = [];
  for (const x of list) { const e = String(x.email || '').toLowerCase(); if (e && !seen.has(e)) { seen.add(e); todo.push(Object.assign(x, { email: e })); } }
  let sent = 0, left = 0;
  for (const x of todo) {
    const r = await S.rest('POST', 'ops_alerts?on_conflict=kind,ref', { kind: 'open_notify', ref: courseId + ':' + x.email }, 'resolution=ignore-duplicates,return=representation');
    if (!(r.ok && r.data.length)) continue;   // 이미 보냄
    if (sent >= 150) { await S.rest('DELETE', 'ops_alerts?kind=eq.open_notify&ref=eq.' + enc(courseId + ':' + x.email)); left++; continue; }
    const m = await MAIL.courseOpen({ email: x.email, course: (c && c.title) || it.name || courseId, buyer: x.buyer });
    if (m.sent) sent++; else { await S.rest('DELETE', 'ops_alerts?kind=eq.open_notify&ref=eq.' + enc(courseId + ':' + x.email)); left++; }
  }
  return { sent, left };
}

/* 권한: 'all' 이면 전부. 화면·작업마다 필요한 권한 */
const PERM_READ = { voices: 'courses', brief: 'dash', dashboard: 'dash', orders: 'orders', orders_csv: 'orders', members: 'members', member: 'members', companies: 'companies', company: 'companies', courses: 'courses', shipments: 'ship', logs: 'logs', leads: 'leads', coupons: 'coupons', admins: 'admins', backups: 'admins', launch: 'admins', kits: 'courses' };
const PERM_ACT = { refund: 'refund', cancel_waiting: 'refund', order_manual: 'refund', pg_sync: 'orders', order_memo: 'orders', grant: 'members', revoke: 'members',
  company_create: 'companies', company_admin: 'companies', seat_add: 'companies', company_invite: 'companies', company_assign: 'companies', company_unassign: 'companies', company_remove: 'companies',
  course_open: 'courses', lesson_save: 'courses', lesson_delete: 'courses', lesson_publish: 'courses', voice_save: 'courses', voice_delete: 'courses', media_upload: 'courses', video_init: 'courses', video_status: 'courses', kit_upload: 'courses', kit_save: 'courses', kit_delete: 'courses',
  shipped: 'ship', lead_update: 'leads', coupon_save: 'coupons', coupon_toggle: 'coupons', admin_save: 'admins', admin_remove: 'admins', convert_self: 'admins', staff_reset: 'admins', pw_changed: 'self', backup_now: 'admins', backup_get: 'admins', purge_test: 'admins' };
const PRESETS = {
  owner:   { label: '대표 (전체 권한)', perms: ['all'] },
  biz:     { label: '기업강의 관리자', perms: ['dash', 'companies', 'leads', 'members', 'orders', 'coupons'] },
  content: { label: '강의 관리자', perms: ['courses'] },
  ops:     { label: '운영·발송', perms: ['orders', 'ship', 'members', 'leads'] },
  finance: { label: '정산·환불', perms: ['dash', 'orders', 'refund', 'coupons', 'logs'] }
};
const PERM_NAMES = { dash: '대시보드', orders: '주문 보기', refund: '환불·직접 등록', members: '회원', companies: '기업', leads: '문의 접수함', courses: '강의·키트', ship: '키트 발송', coupons: '할인 코드', logs: '작업 기록', admins: '권한·백업·출시 점검' };

const READ = {
  async voices() { return { voices: await get('testimonials?select=*&order=sort,id') }; },
  /* 데일리 브리핑: 지난 날은 저장된 것(없으면 만들어 저장), 오늘은 지금까지 실시간 */
  async brief(q) {
    const today = BR.kstDate(Date.now());
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') && q.day <= today ? q.day : BR.kstDate(Date.now() - 864e5);
    if (day === today) return { brief: await BR.build(day), today };
    let b = q.fresh === '1' ? null : await BR.saved(day);
    if (!b) { b = await BR.build(day); await BR.save(b); }
    return { brief: b, today };
  },
  async leads(q) {
    let f = 'leads?select=*&order=created_at.desc&limit=300';
    if (/^(new|talking|proposal|won|lost|done|spam)$/.test(q.status || '')) f += '&status=eq.' + q.status;
    if (q.kind) f += '&kind=eq.' + enc(String(q.kind).slice(0, 60));
    const s2 = String(q.q || '').trim().slice(0, 80).replace(/[,()*]/g, ''), d2 = digits(s2);
    if (s2) f += '&or=(email.ilike.*' + enc(s2) + '*,company.ilike.*' + enc(s2) + '*,name.ilike.*' + enc(s2) + '*,memo.ilike.*' + enc(s2) + '*' + (d2.length >= 4 ? ',phone.ilike.*' + d2 + '*' : '') + ')';
    if (DATE(q.from)) f += '&created_at=gte.' + enc(kstFrom(q.from));
    if (DATE(q.to)) f += '&created_at=lt.' + enc(kstTo(q.to));
    if (q.owner) f += '&owner_email=eq.' + enc(String(q.owner).slice(0, 120));
    const [ls, cnt] = await Promise.all([get(f), get('leads?select=status,kind&limit=5000')]);
    const by = {}; cnt.forEach(x => { by[x.status] = (by[x.status] || 0) + 1; });
    return { leads: ls, counts: by, kinds: [...new Set(cnt.map(x => x.kind))] };
  },
  async coupons() { return { coupons: await get('coupons?select=*&order=created_at.desc'), cats: { biz: '기업 워크샵', salon: '살롱·원데이', cohort: '기수·라이브', vod: 'VOD 강의' } }; },
  async admins() {
    const as = await get('admins?select=user_id,perms,label,staff,added_by,created_at');
    const ps = as.length ? await get('profiles?select=id,email,name&id=in.(' + as.map(a => a.user_id).join(',') + ')') : [];
    const out = [];
    for (const a of as) {
      const p = ps.find(x => x.id === a.user_id);
      let email = p && p.email, name = p && p.name, last = null, must = false;
      if (a.staff) { const r = await S.authAdmin('GET', 'users/' + a.user_id); if (r.ok && r.data) { email = r.data.email; name = (r.data.user_metadata || {}).name || ''; last = r.data.last_sign_in_at; must = !!(r.data.app_metadata || {}).must_change; } }
      out.push(Object.assign(a, { email, name, last, mustChange: must }));
    }
    return { admins: out, presets: PRESETS, names: PERM_NAMES };
  },
  async backups() { return { backups: await BK.list() }; },
  async kits() { return { kits: await get('kit_files?select=id,course_id,title,file_name,size_b,sort,created_at&order=course_id,sort,id') }; },
  /* 출시 점검: 환경 변수·연결 상태·남은 테스트 데이터 */
  async launch() {
    const env = k => !!process.env[k];
    const [tests, cron, hooks, waiting] = await Promise.all([
      get('orders?select=id&is_test=is.true'), get('ops_alerts?select=at&kind=eq.cron_run&order=at.desc&limit=1'),
      get('admin_logs?select=created_at&action=eq.pg_webhook&order=created_at.desc&limit=1'), get('orders?select=id&status=eq.waiting')
    ]);
    const pgOk = await PGA.health();
    return { checks: [
      ['결제', 'PG 운영 키', PGA.mode() === 'live', PGA.mode() === 'live' ? PGA.label + ' 운영 키 사용 중' : '테스트 키 사용 중 (실제 청구 없음)'],
      ['결제', 'PG 연결', pgOk, pgOk ? '정상' : 'PG API에 연결하지 못했어요'],
      ['결제', '웹훅 수신', hooks.length > 0, hooks.length ? '마지막 ' + hooks[0].created_at.slice(0, 16).replace('T', ' ') : '아직 받은 적 없어요 (PG 개발자센터에 웹훅 주소 등록)'],
      ['결제', '테스트 주문 정리', tests.length === 0, tests.length ? '테스트 주문 ' + tests.length + '건 남아 있어요' : '없음'],
      ['메일', '메일 발송 (SMTP)', env('SMTP_USER') && env('SMTP_PASS'), env('SMTP_USER') ? process.env.SMTP_USER : 'SMTP_USER·SMTP_PASS 없음 → 주문·환불·알림 메일이 안 나가요'],
      ['메일', '운영자 알림 주소', env('OPS_EMAIL') || env('SMTP_USER'), process.env.OPS_EMAIL || process.env.SMTP_USER || '없음'],
      ['운영', '예약 작업 (매일 새벽)', env('CRON_SECRET') && cron.length > 0, !env('CRON_SECRET') ? 'CRON_SECRET 없음 → 정리·대사·요약·백업이 안 돌아요' : cron.length ? '마지막 실행 ' + cron[0].at.slice(0, 16).replace('T', ' ') : '아직 실행 기록 없음'],
      ['운영', '문의 시트 상태 연동', env('LEADS_SECRET'), env('LEADS_SECRET') ? '설정됨' : 'LEADS_SECRET 없음 → 접수함 상태가 시트에 안 바뀌어요 (접수는 됨)'],
      ['강의', '영상 (Bunny Stream)', B.configured(), B.configured() ? '연결됨' : '영상 만든 뒤 연결 예정'],
      ['보안', '관리자 2단계 인증', S.mfaOn(), S.mfaOn() ? '켜짐' : '꺼짐 (ADMIN_MFA=on 으로 켤 수 있어요)']
    ].map(c => ({ group: c[0], name: c[1], ok: !!c[2], note: c[3] })), waiting: waiting.length };
  },

  async logs(q) {
    let f = 'admin_logs?select=id,email,action,target,detail,created_at,ip&order=created_at.desc&limit=500';
    const a = String(q.action || ''); if (/^[a-z_]{2,30}$/.test(a)) f += '&action=eq.' + a;
    if (q.who) f += '&email=ilike.*' + enc(String(q.who).replace(/[,()*]/g, '').slice(0, 80)) + '*';
    if (q.q) f += '&target=ilike.*' + enc(String(q.q).replace(/[,()*]/g, '').slice(0, 80)) + '*';
    if (DATE(q.from)) f += '&created_at=gte.' + enc(kstFrom(q.from));
    if (DATE(q.to)) f += '&created_at=lt.' + enc(kstTo(q.to));
    return { logs: await get(f) };
  },
  async orders_csv() {
    return { orders: await get('orders?select=id,paid_at,item_id,qty,amount,refund_amount,status,is_test,buyer_name,buyer_email,method,source,tax_doc,memo,refunded_at,refund_reason,list_amount,discount,coupon_code&status=neq.ready&order=paid_at.desc&limit=5000') };
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
    let f = 'orders?select=id,item_id,qty,amount,list_amount,discount,coupon_code,refund_amount,status,is_test,buyer_email,buyer_name,buyer_phone,paid_at,user_id,refund_requested_at,refund_request_note,refund_reason,shipped_at,method,source,memo,tax_doc,vbank,due_at,created_at&status=neq.ready&order=created_at.desc&limit=500';
    if (q.status === 'requested') f += '&refund_requested_at=not.is.null&status=eq.paid';
    else if (q.status === 'manual') f += '&source=eq.manual';
    else if (['waiting', 'paid', 'partial_refunded', 'refunded', 'expired', 'canceled'].includes(q.status)) f += '&status=eq.' + q.status;
    if (q.test === '0') f += '&is_test=eq.false';
    if (DATE(q.from)) f += '&created_at=gte.' + enc(kstFrom(q.from));
    if (DATE(q.to)) f += '&created_at=lt.' + enc(kstTo(q.to));
    if (q.method) f += '&method=eq.' + enc(String(q.method).slice(0, 30));
    if (/^(biz|salon|cohort|vod|etc)$/.test(q.cat || '')) { const ids = Object.keys(CATALOG).filter(k => catOf(k) === q.cat); f += '&item_id=in.(' + (ids.length ? ids.map(enc).join(',') : 'none') + ')'; }
    if (q.coupon === '1') f += '&discount=gt.0';
    const s = String(q.q || '').trim().slice(0, 80).replace(/[,()*]/g, ''), dg = digits(s);
    if (s) f += '&or=(buyer_email.ilike.*' + enc(s) + '*,id.ilike.*' + enc(s) + '*,buyer_name.ilike.*' + enc(s) + '*,memo.ilike.*' + enc(s) + '*' + (dg.length >= 4 ? ',buyer_phone.ilike.*' + dg + '*,ship_phone.ilike.*' + dg + '*' : '') + ')';
    return { orders: await get(f), methods: [...new Set((await get('orders?select=method&method=not.is.null&limit=2000')).map(o => o.method))] };
  },
  async members(q) {
    let f = 'profiles?select=id,name,email,login_method,marketing_ok,created_at&order=created_at.desc&limit=500';
    const s = String(q.q || '').trim().slice(0, 80).replace(/[,()*]/g, ''), dg = digits(s);
    if (s) {
      /* 휴대폰 번호(하이픈 있어도 없어도): 주문의 주문자·배송 연락처로 회원을 찾음 */
      let ids = [];
      if (dg.length >= 4) { const os = await get('orders?select=user_id,buyer_email&or=(buyer_phone.ilike.*' + dg + '*,ship_phone.ilike.*' + dg + '*)&limit=200'); ids = [...new Set(os.map(o => o.user_id).filter(Boolean))]; }
      f += '&or=(email.ilike.*' + enc(s) + '*,name.ilike.*' + enc(s) + '*' + (ids.length ? ',id.in.(' + ids.join(',') + ')' : '') + ')';
    }
    if (/^(email|kakao|google)$/.test(q.via || '')) f += '&login_method=eq.' + q.via;
    if (q.mk === '1') f += '&marketing_ok=is.true'; else if (q.mk === '0') f += '&marketing_ok=is.false';
    if (DATE(q.from)) f += '&created_at=gte.' + enc(kstFrom(q.from));
    if (DATE(q.to)) f += '&created_at=lt.' + enc(kstTo(q.to));
    let ms = await get(f);
    const en = ms.length ? await get('enrollments?select=user_id,course_id&revoked_at=is.null&user_id=in.(' + ms.map(m => m.id).join(',') + ')') : [];
    const cnt = {}, cs = {}; en.forEach(e => { cnt[e.user_id] = (cnt[e.user_id] || 0) + 1; (cs[e.user_id] = cs[e.user_id] || []).push(e.course_id); });
    if (q.learn === '1') ms = ms.filter(m => cnt[m.id]); else if (q.learn === '0') ms = ms.filter(m => !cnt[m.id]);
    if (q.course) ms = ms.filter(m => (cs[m.id] || []).includes(q.course));
    const ph = ms.length ? await get('orders?select=user_id,buyer_phone,ship_phone&user_id=in.(' + ms.map(m => m.id).join(',') + ')&order=created_at.desc') : [];
    const phone = {}; ph.forEach(o => { if (!phone[o.user_id] && (o.buyer_phone || o.ship_phone)) phone[o.user_id] = o.buyer_phone || o.ship_phone; });
    return { members: ms.map(m => Object.assign(m, { courses: cnt[m.id] || 0, phone: phone[m.id] || '' })) };
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
    const [cs, ls, md, en] = await Promise.all([get('courses?select=id,title,is_open,opened_at&order=id'), get('lessons?select=id,course_id,part,sort,title,is_free,duration_s,published,publish_at&order=course_id,sort'), get('lesson_media?select=lesson_id,provider,video_id,status'), get('enrollments?select=course_id&revoked_at=is.null')]);
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
    const row = { id, user_id: p ? p.id : null, buyer_email: email, buyer_name: name, buyer_phone: digits(b.phone).slice(0, 15) || null, item_id: itemId, qty, amount, method, status: 'paid', paid_at: paidAt, source: 'manual', tax_doc: tax, memo: String(b.memo || '').slice(0, 300) || null, grants_course: CATALOG[itemId].grants || null, is_test: false };
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
  async lead_update(b) {
    const id = int(b.id); if (!(id > 0)) throw new Error('BAD_REQUEST');
    const patch = { updated_at: new Date().toISOString() };
    if (/^(new|talking|proposal|won|lost|done|spam)$/.test(b.status || '')) patch.status = b.status;
    if (typeof b.memo === 'string') patch.memo = b.memo.slice(0, 1000) || null;
    if (typeof b.owner === 'string') patch.owner_email = b.owner.slice(0, 120) || null;
    await write('PATCH', 'leads?id=eq.' + id, patch);
    /* 구글 시트의 '처리 상태'·'메모' 칸도 같이 바꿈 (LEADS_SECRET 이 있을 때) */
    let sheet = false;
    if (process.env.LEADS_SECRET) {
      const L = { new: '새 문의', talking: '상담 중', proposal: '제안·견적', won: '계약', lost: '보류·무산', done: '처리 완료', spam: '스팸' };
      try {
        const r = await fetch(process.env.LEADS_SHEET_URL || 'https://script.google.com/macros/s/AKfycbznjt7abxus2cE7sAse9CBHc6JzKfrYzUArrwLGUFwMfaYk4YkSanxEbp8voRDcYoaPbA/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
          body: JSON.stringify({ action: 'status', secret: process.env.LEADS_SECRET, id: 'L' + id, status: patch.status ? L[patch.status] : undefined, memo: patch.memo }) });
        sheet = r.ok && (await r.text()).trim() === 'ok';
      } catch (e) {}
    }
    return { sheet };
  },
  async coupon_save(b) {
    const code = PRICE.cleanCode(b.code); if (code.length < 3) throw new Error('BAD_REQUEST');
    const kind = b.kind === 'amount' ? 'amount' : 'percent', value = int(b.value);
    if (!(value > 0) || (kind === 'percent' && value > 100)) throw new Error('BAD_REQUEST');
    const arr = (v, re) => Array.isArray(v) ? v.map(String).filter(x => re.test(x)).slice(0, 50) : null;
    const opt = v => (v === '' || v == null) ? null : int(v);
    const dt = v => v ? new Date(v).toISOString() : null;
    const row = { code, title: String(b.title || code).slice(0, 80), kind, value, auto: !!b.auto, items: arr(b.items, /^[a-z0-9-]{2,40}$/), cats: arr(b.cats, /^(biz|salon|cohort|vod)$/),
      min_amount: opt(b.min_amount) || 0, max_discount: opt(b.max_discount), starts_at: dt(b.starts_at), ends_at: dt(b.ends_at), max_uses: opt(b.max_uses), per_email: opt(b.per_email), active: b.active !== false, memo: String(b.memo || '').slice(0, 300) || null };
    if (row.items && !row.items.length) row.items = null; if (row.cats && !row.cats.length) row.cats = null;
    await write('POST', 'coupons?on_conflict=code', row, 'resolution=merge-duplicates,return=minimal');
    return { code };
  },
  async coupon_toggle(b) { const code = PRICE.cleanCode(b.code); await write('PATCH', 'coupons?code=eq.' + enc(code), { active: !!b.active }); return {}; },
  /* 관리자 추가 = 관리자 전용 계정 만들기 (사이트 회원 이메일은 못 씀). 임시 비밀번호는 한 번만 보여 줌 */
  async admin_save(b) {
    let perms = Array.isArray(b.perms) ? b.perms.filter(x => x === 'all' || PERM_NAMES[x]) : [];
    if (b.preset && PRESETS[b.preset]) perms = PRESETS[b.preset].perms;
    if (!perms.length) throw new Error('BAD_REQUEST');
    const label = String(b.label || (PRESETS[b.preset] || {}).label || '').slice(0, 40) || null;
    if (b.userId) {   // 권한만 바꾸기
      const id = uuid(b.userId); if (!id) throw new Error('BAD_REQUEST');
      if (id === b._uid && !perms.includes('all')) throw new Error('SELF');
      await write('PATCH', 'admins?user_id=eq.' + id, { perms, label });
      return {};
    }
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim().slice(0, 40);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) throw new Error('BAD_REQUEST');
    if ((await get('profiles?select=id&email=ilike.' + enc(email))).length) throw new Error('EMAIL_TAKEN');
    const temp = tempPassword();
    const c = await S.authAdmin('POST', 'users', { email, password: temp, email_confirm: true, app_metadata: { role: 'staff', must_change: true }, user_metadata: { name } });
    if (!c.ok || !c.data || !c.data.id) { if (c.status === 422) throw new Error('EMAIL_TAKEN'); throw new Error('AUTH_CREATE'); }
    await write('POST', 'admins', { user_id: c.data.id, perms, label, staff: true, added_by: b._by || null });
    return { tempPassword: temp, email };
  },
  /* 처음 전환용: 지금 들어온 '사이트 회원 계정 관리자'를 같은 이메일의 관리자 전용 계정으로 바꿈
     회원 계정은 탈퇴와 같은 방식으로 지움(주문은 연결만 끊고 5년 보관). 임시 비밀번호를 한 번 돌려줌 */
  async convert_self(b) {
    if (!b._legacy || b.confirm !== 'convert') throw new Error('BAD_REQUEST');
    const [me] = await get('admins?select=perms,label&user_id=eq.' + b._uid);
    const email = String(b._by || '').toLowerCase();
    if (!me || !email) throw new Error('BAD_REQUEST');
    await write('PATCH', 'orders?user_id=eq.' + b._uid, { user_id: null, detached_at: new Date().toISOString() });
    const d = await S.deleteAuthUser(b._uid);
    if (!d.ok) throw new Error('AUTH_CREATE');
    const temp = tempPassword();
    const c = await S.authAdmin('POST', 'users', { email, password: temp, email_confirm: true, app_metadata: { role: 'staff', must_change: true }, user_metadata: { name: String(b.name || '').slice(0, 40) } });
    if (!c.ok || !c.data || !c.data.id) { console.error('convert create', c.status, c.text); throw new Error('AUTH_CREATE'); }
    await write('POST', 'admins', { user_id: c.data.id, perms: me.perms && me.perms.length ? me.perms : ['all'], label: me.label || '대표 (전체 권한)', staff: true, added_by: email });
    await S.log({ id: c.data.id, email }, 'convert_self', email, { from: 'site member', to: 'staff' }, null);
    return { email, tempPassword: temp };
  },
  async staff_reset(b) {
    const id = uuid(b.userId); if (!id) throw new Error('BAD_REQUEST');
    const [a] = await get('admins?select=staff&user_id=eq.' + id); if (!a || !a.staff) throw new Error('BAD_REQUEST');
    const temp = tempPassword();
    const r = await S.authAdmin('PUT', 'users/' + id, { password: temp, app_metadata: { role: 'staff', must_change: true } });
    if (!r.ok) throw new Error('AUTH_CREATE');
    return { tempPassword: temp };
  },
  /* 첫 로그인 비밀번호 변경 뒤 (본인) */
  async pw_changed(b) {
    if (!b._staff) return {};
    const r = await S.authAdmin('PUT', 'users/' + b._uid, { app_metadata: { role: 'staff', must_change: false } });
    if (!r.ok) throw new Error('AUTH_CREATE');
    return {};
  },
  async admin_remove(b) {
    const id = uuid(b.userId); if (!id) throw new Error('BAD_REQUEST');
    if (id === b._uid) throw new Error('SELF');
    const all = await get('admins?select=user_id,perms,staff');
    const me = all.find(a => a.user_id === id);
    if (!me) throw new Error('BAD_REQUEST');
    if ((me.perms || []).includes('all') && all.filter(a => a.user_id !== id && (a.perms || []).includes('all')).length === 0) throw new Error('LAST_OWNER');
    await write('DELETE', 'admins?user_id=eq.' + id);
    if (me.staff) await S.authAdmin('DELETE', 'users/' + id);   // 관리자 전용 계정은 계정째 지움
    return {};
  },
  async kit_upload(b) {
    const course = String(b.courseId || ''); if (!(await get('courses?select=id&id=eq.' + enc(course))).length) throw new Error('BAD_REQUEST');
    /* 저장소 경로는 영문·숫자만 (한글 파일명은 내려받을 때 원래 이름으로 바꿔 줌) */
    const ext = (String(b.fileName || '').match(/\.([A-Za-z0-9]{1,8})$/) || [])[1] || 'bin';
    const path = course + '/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext.toLowerCase();
    const url = await S.signedPut('kits', path);
    if (!url) throw new Error('STORAGE');
    return { url, path };
  },
  async kit_save(b) {
    const course = String(b.courseId || ''), path = String(b.path || '');
    if (!course || !path.startsWith(course + '/')) throw new Error('BAD_REQUEST');
    const row = { course_id: course, title: String(b.title || b.fileName || '키트').slice(0, 120), storage_path: path, file_name: String(b.fileName || '').slice(0, 120) || null, size_b: int(b.size) || null, sort: int(b.sort) || 0 };
    const r = await write('POST', 'kit_files', row);
    return { id: r && r[0] && r[0].id };
  },
  async kit_delete(b) {
    const id = int(b.id); if (!(id > 0)) throw new Error('BAD_REQUEST');
    const [k] = await get('kit_files?select=storage_path&id=eq.' + id);
    if (!k) throw new Error('BAD_REQUEST');
    await write('DELETE', 'kit_files?id=eq.' + id);
    await S.storage('DELETE', 'object/kits', { prefixes: [k.storage_path] });
    return {};
  },
  async backup_now() { return await BK.run('manual'); },
  async backup_get(b) { const n = String(b.name || ''); if (!/^chaand-[\w-]+\.json\.gz$/.test(n)) throw new Error('BAD_REQUEST'); return { url: await S.signedGet('backups', n, 120, n) }; },
  /* 출시 직전: 테스트 결제 주문과 그 주문으로 생긴 수강권 지우기 */
  async purge_test(b) {
    if (b.confirm !== 'delete-test') throw new Error('BAD_REQUEST');
    const ts = await get('orders?select=id&is_test=is.true');
    if (!ts.length) return { deleted: 0 };
    const ids = ts.map(o => enc(o.id)).join(',');
    await write('DELETE', 'enrollments?order_id=in.(' + ids + ')');
    await write('DELETE', 'orders?id=in.(' + ids + ')');
    return { deleted: ts.length };
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
    let notified = 0, left = 0;
    if (b.open && b.notify) { const n = await notifyOpen(id); notified = n.sent; left = n.left; }
    return { ok: true, notified, left, mail: MAIL.ready() };
  },
  async lesson_save(b) {
    const course = String(b.courseId || ''), title = String(b.title || '').trim().slice(0, 120), sort = int(b.sort);
    if (!course || !title || !(sort > 0)) throw new Error('BAD_REQUEST');
    const row = { course_id: course, part: String(b.part || '').trim().slice(0, 60), sort, title, is_free: !!b.isFree, duration_s: Math.max(0, int(b.durationS) || 0), published: b.published !== false, publish_at: b.publishAt ? new Date(b.publishAt).toISOString() : null };
    let id = int(b.id);
    if (id > 0) await write('PATCH', 'lessons?id=eq.' + id, row);
    else { const r = await write('POST', 'lessons', row); id = r[0].id; }
    const vid = String(b.videoId || '').trim().slice(0, 100);
    if (vid) await write('POST', 'lesson_media', { lesson_id: id, provider: 'bunny', video_id: vid }, 'resolution=merge-duplicates,return=minimal');
    else await write('DELETE', 'lesson_media?lesson_id=eq.' + id);
    return { id };
  },
  /* 편 공개 켜기·끄기 (목록에서 바로) */
  async lesson_publish(b) { const id = int(b.id); if (!(id > 0)) throw new Error('BAD_REQUEST'); await write('PATCH', 'lessons?id=eq.' + id, { published: !!b.on, publish_at: null }); return {}; },
  /* 후기·레퍼런스 */
  async voice_save(b) {
    const quote = String(b.quote || '').trim().slice(0, 400); if (!quote) throw new Error('BAD_REQUEST');
    const t = v => String(v || '').trim().slice(0, 80) || null;
    const row = { quote, name: t(b.name), role: t(b.role), company: t(b.company), program: t(b.program), photo_url: /^https:\/\/mryawowqarptvtpxcwxl\.supabase\.co\/storage\/v1\/object\/public\/media\//.test(String(b.photo || '')) ? String(b.photo).slice(0, 400) : null, published: !!b.published, consent: !!b.consent, sort: int(b.sort) || 0 };
    if (row.published && !row.consent) throw new Error('NO_CONSENT');
    const id = int(b.id);
    if (id > 0) await write('PATCH', 'testimonials?id=eq.' + id, row); else await write('POST', 'testimonials', row);
    return {};
  },
  async voice_delete(b) { const id = int(b.id); if (!(id > 0)) throw new Error('BAD_REQUEST'); await write('DELETE', 'testimonials?id=eq.' + id); return {}; },
  /* 사이트에 보일 사진 올리기 (공개 저장소 media). 경로는 영문만 */
  async media_upload(b) {
    const ext = ((String(b.fileName || '').match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg').toLowerCase();
    const path = 'voices/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const url = await S.signedPut('media', path); if (!url) throw new Error('STORAGE');
    return { url, publicUrl: 'https://mryawowqarptvtpxcwxl.supabase.co/storage/v1/object/public/media/' + path };
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
    /* admin.chaand.ai 를 쓰기 시작하면(ADMIN_HOST) 본 사이트 주소로 들어온 관리자 요청은 막음 */
    const host = String(req.headers.host || '').toLowerCase();
    if (process.env.ADMIN_HOST && /(^|\.)chaand\.ai$/.test(host) && host !== process.env.ADMIN_HOST) return S.send(res, 403, { ok: false, code: 'WRONG_HOST', host: process.env.ADMIN_HOST });
    const tok = S.bearer(req), u = await S.user(tok, { staff: true }), A = await S.isAdmin(u, tok), ip = S.ip(req);
    if (!A) return S.send(res, 403, { ok: false, code: 'NOT_ADMIN' });
    /* 첫 로그인: 임시 비밀번호를 바꾸기 전에는 다른 일을 못 함 */
    const qr = (req.query || {}).r;
    if (A.mustChange && !(req.method === 'GET' && qr === 'me')) {
      const bb = req.method === 'POST' ? (await S.readJson(req) || {}) : {};
      if (bb.action !== 'pw_changed') return S.send(res, 403, { ok: false, code: 'PW_CHANGE' });
      req.body = bb;
    }
    if (req.method === 'GET' && (req.query || {}).r === 'me') return S.send(res, 200, { ok: true, admin: true, aal: S.aal(tok), mfa: S.mfaOn(), perms: A.perms, label: A.label, names: PERM_NAMES, staff: A.staff, legacy: !!A.legacy, mustChange: !!A.mustChange, email: u.email, name: (u.user_metadata || {}).name || '' });
    if (S.mfaOn() && S.aal(tok) !== 'aal2') return S.send(res, 403, { ok: false, code: 'MFA_REQUIRED' });   // 운영 작업은 2단계 인증 뒤에만
    if (req.method === 'GET') {
      const q = req.query || {}, fn = READ[q.r];
      if (!fn) return S.send(res, 400, { ok: false, code: 'BAD_RESOURCE' });
      if (!S.can(A, PERM_READ[q.r] || 'admins')) return S.send(res, 403, { ok: false, code: 'NO_PERM' });
      /* 개인정보를 여는 화면은 열람 기록을 남김 (접속기록 1년 이상 보관) */
      if (['member', 'orders_csv', 'leads', 'members'].includes(q.r)) await S.log(u, 'view_' + q.r, q.id || q.q || null, null, ip);
      return S.send(res, 200, Object.assign({ ok: true }, await fn(q)));
    }
    const b = await S.readJson(req, 32000) || {}, fn = ACT[b.action];
    if (!fn) return S.send(res, 400, { ok: false, code: 'BAD_ACTION' });
    if (PERM_ACT[b.action] !== 'self' && !S.can(A, PERM_ACT[b.action] || 'admins')) return S.send(res, 403, { ok: false, code: 'NO_PERM' });
    b._uid = u.id; b._by = u.email; b._staff = !!A.staff; b._legacy = !!A.legacy;
    const out = await fn(b);
    delete b._uid; delete b._by; delete b._staff; delete b._legacy;
    if (!/^(video_status|backup_get|pw_changed|convert_self)$/.test(b.action)) {
      const keep = Object.assign({}, b); delete keep.action;
      if (keep.refundAccount) keep.refundAccount = '(환불 계좌 받음, 저장 안 함)';
      delete keep.password;
      await S.log(u, b.action, b.orderId || b.userId || b.enrollmentId || b.companyId || b.courseId || b.code || b.email || b.id || null, keep, ip);
    }
    return S.send(res, 200, Object.assign({ ok: true }, out));
  } catch (e) {
    const m = String(e && e.message || '');
    if (e && e.pg) return S.send(res, 402, { ok: false, code: String(e.pg.code || 'PG_REJECTED').slice(0, 60), message: String(e.pg.message || '').slice(0, 200) });
    if (/^(BAD_REQUEST|BAD_ID|NOT_REFUNDABLE|TOO_MUCH|NO_MEMBER|NO_SEATS|SEAT_EXPIRED|BUNNY_NOT_SET|VBANK_REFUND|SELF|LAST_OWNER|STORAGE|EMAIL_TAKEN|AUTH_CREATE|NO_CONSENT)$/.test(m)) return S.send(res, 400, { ok: false, code: m });
    console.error('admin', m);
    return S.send(res, 500, { ok: false, code: 'SERVER' });
  }
};
