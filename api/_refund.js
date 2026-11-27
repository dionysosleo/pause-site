/* 환불 금액 계산 — 취소·환불정책(policies.js 'refund')과 같은 기준. 정책을 바꾸면 여기도 같이 고친다.
   VOD 온라인 강의(제9조):
     - 사전 예약(강의를 열기 전): 언제든 전액
     - 수강 시작일부터 7일 이내 · 2편 이하 시청 · 파일 키트 안 받음: 전액
     - 7일 이내 그 밖: 낸 금액 − 낸 금액 × 시청 편 수 ÷ 전체 편 수 (키트 금액을 따로 표시하지 않으므로 키트 차감 없음)
     - 7일 뒤: 경과 비율 = max(지난 날수 ÷ 30, 시청 편 수 ÷ 전체 편 수) → 1/3 전 2/3, 1/2 전 1/2, 그 뒤 0
     - 시청 = 맛보기가 아닌 편을 60초 넘게 재생. 수강 시작일 = 결제일, 사전 예약 상품은 강의를 연 날.
   파일 키트 단독: 7일 이내 전액(내려받기 전), 그 뒤 0.
   기수제·라이브·실물 키트 발송 뒤: 회차·발송 상태를 사람이 확인해야 해서 '신청 접수'로 처리(자동 환불 안 함).
   금액은 10원 미만 버림, 이미 환불한 금액은 뺀다. */
const S = require('./_sb.js');
const CATALOG = require('../shop/catalog.json').items;
const DAY = 86400000, NORMAL_DAYS = 30;

async function quote(orderId, now) {
  now = now || Date.now();
  const g = await S.rest('GET', 'orders?select=id,user_id,item_id,amount,refund_amount,status,paid_at,grants_course,shipped_at,refund_requested_at&id=eq.' + encodeURIComponent(orderId));
  const o = g.ok && g.data && g.data[0];
  if (!o) return { ok: false, code: 'NO_ORDER' };
  const item = CATALOG[o.item_id] || {};
  const paid = o.amount, left = paid - (o.refund_amount || 0);
  const base = { ok: true, order: o, paid, left, already: o.refund_amount || 0 };
  if (!['paid', 'partial_refunded'].includes(o.status) || left <= 0) return Object.assign(base, { amount: 0, auto: false, rule: '이미 환불했거나 환불할 수 없는 주문이에요.' });
  const kind = String(item.refund || '');
  const floor10 = n => Math.max(0, Math.floor(n / 10) * 10);
  const fit = n => Math.min(left, floor10(n - (o.refund_amount || 0)));   // 정책 금액에서 이미 돌려준 만큼 빼기

  if (/^정기 프로그램|기수제|라이브 강의/.test(kind)) return Object.assign(base, { amount: null, auto: false, rule: '기수제·라이브 과정은 진행한 회차를 확인해 환불 금액을 정해요(첫 회차 전 전액, 1/3 전 2/3, 1/2 전 1/2).' });
  if (/실물 키트/.test(kind) && o.shipped_at) return Object.assign(base, { amount: null, auto: false, rule: '차 키트가 이미 발송돼서, 강의 부분과 키트 부분을 나눠 확인한 뒤 환불 금액을 정해요.' });

  const paidAt = new Date(o.paid_at || Date.now()).getTime();
  if (!o.grants_course) {   // 파일 키트 단독
    const d = (now - paidAt) / DAY;
    return d <= 7 ? Object.assign(base, { amount: fit(paid), auto: true, rule: '결제 후 7일 이내 파일 키트 단독 상품: 전액 환불' })
                  : Object.assign(base, { amount: 0, auto: false, rule: '결제 후 7일이 지난 파일 키트 단독 상품은 환불되지 않아요.' });
  }
  const cg = await S.rest('GET', 'courses?select=is_open,opened_at&id=eq.' + encodeURIComponent(o.grants_course));
  const course = cg.ok && cg.data && cg.data[0];
  if (!course || !course.is_open) return Object.assign(base, { amount: fit(paid), auto: true, rule: '사전 예약(강의 오픈 전): 전액 환불' });

  const start = Math.max(paidAt, course.opened_at ? new Date(course.opened_at).getTime() : paidAt);
  const days = Math.max(0, (now - start) / DAY);
  let watched = 0, total = 0, kit = false;
  if (o.user_id) {
    const ls = await S.rest('GET', 'lessons?select=id&is_free=eq.false&course_id=eq.' + encodeURIComponent(o.grants_course));
    const ids = (ls.data || []).map(x => x.id); total = ids.length;
    if (ids.length) {
      const pr = await S.rest('GET', 'progress?select=lesson_id,watched_s&user_id=eq.' + o.user_id + '&lesson_id=in.(' + ids.join(',') + ')');
      watched = (pr.data || []).filter(x => x.watched_s > 60).length;
    }
    const kf = await S.rest('GET', 'kit_files?select=id&course_id=eq.' + encodeURIComponent(o.grants_course));
    const kids = (kf.data || []).map(x => x.id);
    if (kids.length) { const kd = await S.rest('GET', 'kit_downloads?select=kit_id&user_id=eq.' + o.user_id + '&kit_id=in.(' + kids.join(',') + ')'); kit = (kd.data || []).length > 0; }
  }
  const ratioW = total ? watched / total : 0;
  const facts = { days: Math.floor(days), watched, total, kit };
  if (days <= 7) {
    if (watched <= 2 && !kit) return Object.assign(base, facts, { amount: fit(paid), auto: true, rule: '수강 시작 7일 이내 · 2편 이하 시청 · 키트 미다운로드: 전액 환불' });
    return Object.assign(base, facts, { amount: fit(paid - paid * ratioW), auto: true, rule: '수강 시작 7일 이내: 낸 금액에서 시청한 편 수(' + watched + '/' + total + ') 비율만큼 빼고 환불' });
  }
  const r = Math.max(days / NORMAL_DAYS, ratioW);
  if (r < 1 / 3) return Object.assign(base, facts, { amount: fit(paid * 2 / 3), auto: true, rule: '7일이 지났고 정상 수강기간(30일)의 1/3 전: 낸 금액의 2/3 환불' });
  if (r < 1 / 2) return Object.assign(base, facts, { amount: fit(paid / 2), auto: true, rule: '정상 수강기간의 1/3이 지나고 1/2 전: 낸 금액의 1/2 환불' });
  return Object.assign(base, facts, { amount: 0, auto: false, rule: '정상 수강기간(30일)의 1/2이 지나 환불되지 않아요.' });
}
module.exports = { quote };
