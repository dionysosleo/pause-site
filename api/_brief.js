/* 데일리 브리핑 (이그제큐티브 서머리): 하루를 숫자로 요약하고, 비교·눈여겨볼 점·오늘 할 일을 문장으로 만듦.
   매일 새벽 예약 작업이 '어제' 것을 만들어 저장(briefings)하고 운영자에게 메일로도 보내요. 대시보드 맨 위에 보여요.
   AI가 쓰는 글이 아니라 정해진 규칙으로 만들어서, 같은 데이터면 늘 같은 문장이 나와요. */
const S = require('./_sb.js');
const CATALOG = require('../shop/catalog.json').items;
const won = n => Number(Math.round(n || 0)).toLocaleString('ko-KR') + '원';
const KST = 9 * 3600e3;
const dayStart = d => new Date(Date.parse(d + 'T00:00:00+09:00'));
const iso = t => new Date(t).toISOString();
const kstDate = t => new Date(t + KST).toISOString().slice(0, 10);
const catOf = id => { const r = String((CATALOG[id] || {}).refund || ''); return /기업/.test(r) ? '기업 워크샵' : /살롱|원데이/.test(r) ? '살롱·원데이' : /기수|라이브|정기/.test(r) ? '기수·라이브' : /VOD/.test(r) ? 'VOD 강의' : '기타'; };
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const arrow = p => p == null ? '' : p > 0 ? ' (▲' + p + '%)' : p < 0 ? ' (▼' + Math.abs(p) + '%)' : ' (변화 없음)';
async function get(path) { const r = await S.rest('GET', path); return r.ok && Array.isArray(r.data) ? r.data : []; }
const REV = 'status=in.(paid,partial_refunded,refunded)&is_test=is.false';

async function build(day, opt) {
  opt = opt || {};
  const t0 = dayStart(day).getTime(), t1 = t0 + 864e5;
  const from = iso(t0), to = iso(Math.min(t1, Date.now()));
  const wk = iso(t0 - 7 * 864e5);                                   // 직전 7일 (비교 기준)
  const m0 = dayStart(day.slice(0, 8) + '01').getTime();           // 그 달 1일
  const pm = new Date(m0 + KST); pm.setUTCMonth(pm.getUTCMonth() - 1);
  const pm0 = Date.parse(pm.toISOString().slice(0, 10) + 'T00:00:00+09:00'), pmTo = pm0 + (t1 - m0);   // 지난달 같은 기간
  const [od, o7, om, opm, rf, ms, m7, ls, todo, en, coupons, pr] = await Promise.all([
    get('orders?select=id,item_id,qty,amount,discount,coupon_code,method,source,buyer_name&paid_at=gte.' + encodeURIComponent(from) + '&paid_at=lt.' + encodeURIComponent(to) + '&' + REV),
    get('orders?select=amount,paid_at&paid_at=gte.' + encodeURIComponent(wk) + '&paid_at=lt.' + encodeURIComponent(from) + '&' + REV),
    get('orders?select=amount,refund_amount&paid_at=gte.' + encodeURIComponent(iso(m0)) + '&paid_at=lt.' + encodeURIComponent(to) + '&' + REV),
    get('orders?select=amount,refund_amount&paid_at=gte.' + encodeURIComponent(iso(pm0)) + '&paid_at=lt.' + encodeURIComponent(iso(Math.min(pmTo, m0))) + '&' + REV),
    get('orders?select=id,item_id,refund_amount,refund_reason&refunded_at=gte.' + encodeURIComponent(from) + '&refunded_at=lt.' + encodeURIComponent(to) + '&is_test=is.false'),
    get('profiles?select=id&created_at=gte.' + encodeURIComponent(from) + '&created_at=lt.' + encodeURIComponent(to)),
    get('profiles?select=id&created_at=gte.' + encodeURIComponent(wk) + '&created_at=lt.' + encodeURIComponent(from)),
    get('leads?select=id,kind,company,name,status,created_at&created_at=gte.' + encodeURIComponent(from) + '&created_at=lt.' + encodeURIComponent(to)),
    get('orders?select=id,status,refund_requested_at,shipped_at,ship_addr,item_id,due_at,amount&status=in.(paid,waiting)&is_test=is.false'),
    get('progress?select=user_id,completed_at&updated_at=gte.' + encodeURIComponent(from) + '&updated_at=lt.' + encodeURIComponent(to)),
    get('coupons?select=code,title,ends_at,auto,active&active=is.true'),
    get('leads?select=id,kind,company,name,created_at&status=eq.new&created_at=lt.' + encodeURIComponent(iso(Date.now() - 864e5)))
  ]);
  const gross = od.reduce((s, o) => s + o.amount, 0), refunds = rf.reduce((s, o) => s + (o.refund_amount || 0), 0), net = gross - refunds;
  const avg7 = o7.reduce((s, o) => s + o.amount, 0) / 7, avg7n = o7.length / 7, mem7 = m7.length / 7;
  const mNet = om.reduce((s, o) => s + o.amount - (o.refund_amount || 0), 0), pmNet = opm.reduce((s, o) => s + o.amount - (o.refund_amount || 0), 0);
  const learners = new Set(en.map(x => x.user_id)).size, doneLessons = en.filter(x => x.completed_at && x.completed_at >= from && x.completed_at < to).length;
  /* 분야·상품 */
  const byCat = {}, byItem = {};
  od.forEach(o => { const c = catOf(o.item_id); byCat[c] = (byCat[c] || 0) + o.amount; const n = (CATALOG[o.item_id] || {}).name || o.item_id; byItem[n] = (byItem[n] || 0) + 1; });
  const topItem = Object.entries(byItem).sort((a, b) => b[1] - a[1])[0];
  const big = od.filter(o => o.amount >= 1000000).sort((a, b) => b.amount - a.amount);
  const disc = od.filter(o => o.discount > 0), discSum = disc.reduce((s, o) => s + o.discount, 0);
  const manual = od.filter(o => o.source === 'manual');
  /* 처리할 일 */
  const isKit = id => /차 키트/.test(String((CATALOG[id] || {}).note || ''));
  const T = {
    refunds: todo.filter(o => o.status === 'paid' && o.refund_requested_at).length,
    waiting: todo.filter(o => o.status === 'waiting').length,
    waitingSoon: todo.filter(o => o.status === 'waiting' && o.due_at && Date.parse(o.due_at) < Date.now() + 864e5).length,
    ship: todo.filter(o => o.status === 'paid' && isKit(o.item_id) && !o.shipped_at).length,
    shipNoAddr: todo.filter(o => o.status === 'paid' && isKit(o.item_id) && !o.shipped_at && !o.ship_addr).length,
    staleLeads: pr.length
  };
  const endingCoupons = coupons.filter(c => c.ends_at && Date.parse(c.ends_at) > Date.now() && Date.parse(c.ends_at) < Date.now() + 3 * 864e5);

  /* 문장 */
  const partial = t1 > Date.now();
  const headline = od.length
    ? (partial ? '오늘 지금까지 ' : '') + '순매출 ' + won(net) + ' · 주문 ' + od.length + '건' + (partial ? '' : arrow(pct(gross, avg7)).replace('(', '(지난 7일 평균 대비 ')) + ', 새 회원 ' + ms.length + '명, 새 문의 ' + ls.length + '건이에요.'
    : (partial ? '오늘은 아직 주문이 없어요. ' : '주문이 없었어요. ') + '새 회원 ' + ms.length + '명, 새 문의 ' + ls.length + '건' + (refunds ? ', 환불 ' + won(refunds) : '') + '이에요.';
  const points = [];
  if (!partial && od.length) points.push('주문 ' + od.length + '건은 지난 7일 하루 평균 ' + (Math.round(avg7n * 10) / 10) + '건' + (od.length > avg7n * 1.5 ? '보다 많았어요.' : od.length < avg7n * 0.5 ? '보다 적었어요.' : '과 비슷했어요.'));
  if (Object.keys(byCat).length) points.push('분야별: ' + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + won(v)).join(' · '));
  if (topItem && od.length > 1) points.push('가장 많이 팔린 상품은 「' + topItem[0] + '」 ' + topItem[1] + '건이에요.');
  big.slice(0, 3).forEach(o => points.push('큰 주문: ' + (o.buyer_name || '고객') + ' · ' + ((CATALOG[o.item_id] || {}).name || o.item_id) + ' ' + won(o.amount) + (o.source === 'manual' ? ' (직접 등록)' : '')));
  if (manual.length && !big.some(o => o.source === 'manual')) points.push('직접 등록한 거래 ' + manual.length + '건 ' + won(manual.reduce((s, o) => s + o.amount, 0)) + '이 포함돼 있어요.');
  if (disc.length) points.push('할인 적용 ' + disc.length + '건 · 할인 금액 ' + won(discSum) + ' (' + [...new Set(disc.map(o => o.coupon_code))].join(', ') + ')');
  if (refunds) points.push('환불 ' + rf.length + '건 ' + won(refunds) + ' — ' + rf.slice(0, 2).map(o => ((CATALOG[o.item_id] || {}).name || o.item_id)).join(', ') + (rf.length > 2 ? ' 외' : ''));
  if (ms.length && !partial) points.push('새 회원 ' + ms.length + '명' + (mem7 ? ' (지난 7일 평균 ' + (Math.round(mem7 * 10) / 10) + '명)' : '') + '.');
  const bizLeads = ls.filter(l => /워크샵|제안서|기업|단체|패키지/.test(l.kind));
  if (bizLeads.length) points.push('기업 문의 ' + bizLeads.length + '건: ' + bizLeads.slice(0, 3).map(l => (l.company || l.name || '-')).join(', ') + (bizLeads.length > 3 ? ' 외' : ''));
  if (learners) points.push('강의를 본 회원 ' + learners + '명, 끝낸 편 ' + doneLessons + '편.');
  points.push('이번 달 누적 순매출 ' + won(mNet) + (pmNet ? arrow(pct(mNet, pmNet)).replace('(', '(지난달 같은 기간 대비 ') : '') + '.');
  const todos = [];
  if (T.refunds) todos.push({ t: '환불 신청 ' + T.refunds + '건 확인', go: 'orders/requested' });
  if (T.staleLeads) todos.push({ t: '하루 넘게 답하지 않은 문의 ' + T.staleLeads + '건 (' + pr.slice(0, 3).map(l => l.company || l.name || l.kind).join(', ') + ')', go: 'leads/new' });
  if (T.waitingSoon) todos.push({ t: '입금 기한 하루 안 남은 가상계좌 ' + T.waitingSoon + '건', go: 'orders/waiting' });
  if (T.ship) todos.push({ t: '차 키트 발송 ' + T.ship + '건' + (T.shipNoAddr ? ' (배송지 미입력 ' + T.shipNoAddr + '건은 고객 안내)' : ''), go: 'ship' });
  endingCoupons.forEach(c => todos.push({ t: '할인 「' + c.title + '」 ' + new Date(Date.parse(c.ends_at) + KST).toISOString().slice(5, 10).replace('-', '/') + ' 종료 예정 — 연장할지 결정', go: 'coupons' }));
  const alerts = [];
  if (opt.health) { const h = opt.health; if (!h.pg) alerts.push('결제(PG) 연결에 문제가 있어요.'); if (!h.mail) alerts.push('메일 발송이 설정되지 않았어요.'); }
  return { day, partial, made_at: new Date().toISOString(), headline, points, todos, alerts,
    numbers: { net, gross, refunds, orders: od.length, members: ms.length, leads: ls.length, learners, avg7: Math.round(avg7), monthNet: mNet, prevMonthNet: pmNet } };
}
async function saved(day) { const r = await get('briefings?select=data&day=eq.' + day); return r[0] ? r[0].data : null; }
async function save(b) { await S.rest('POST', 'briefings?on_conflict=day', { day: b.day, data: b, made_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal'); }
module.exports = { build, saved, save, kstDate };
