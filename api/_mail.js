/* 메일 발송 (Google Workspace SMTP). Vercel 환경 변수:
   SMTP_USER(보내는 계정, 예: help@chaandai.com), SMTP_PASS(구글 앱 비밀번호), MAIL_FROM(선택, 보이는 이름)
   값이 없으면 보내지 않고 조용히 넘어감(결제·환불 처리는 그대로). */
const SITE = 'https://www.chaand.ai';
let tx = null;
function ready() { return !!(process.env.SMTP_USER && process.env.SMTP_PASS); }
function transport() {
  if (tx) return tx;
  const nodemailer = require('nodemailer');
  tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  return tx;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const won = n => Number(n || 0).toLocaleString('ko-KR') + '원';
function wrap(title, rows, body, foot) {
  const table = rows.length ? '<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">' + rows.map(r => '<tr><td style="padding:8px 0;color:#6B727A;width:120px;vertical-align:top">' + esc(r[0]) + '</td><td style="padding:8px 0">' + esc(r[1]) + '</td></tr>').join('') + '</table>' : '';
  return '<div style="max-width:560px;margin:0 auto;padding:28px 20px;font-family:\'Apple SD Gothic Neo\',\'Noto Sans KR\',sans-serif;color:#26313D;line-height:1.65">' +
    '<p style="letter-spacing:.2em;margin:0 0 20px">CHA&amp;I</p><h1 style="font-size:20px;margin:0 0 8px">' + esc(title) + '</h1>' + body + table + (foot || '') +
    '<p style="font-size:12px;color:#8A8F96;margin:28px 0 0;border-top:1px solid #E3E6EA;padding-top:14px">이 메일은 거래에 필요한 안내라 수신 동의와 관계없이 보내요. 문의: ' + esc(process.env.SMTP_USER || '') + '<br>CHA&amp;I · <a href="' + SITE + '/terms" style="color:#8A8F96">이용약관</a> · <a href="' + SITE + '/privacy" style="color:#8A8F96">개인정보처리방침</a> · <a href="' + SITE + '/refund" style="color:#8A8F96">취소·환불정책</a></p></div>';
}
function text(title, rows, lines) { return [title, ''].concat(rows.map(r => r[0] + ': ' + r[1])).concat([''], lines || []).join('\n'); }
async function send(to, subject, html, txt) {
  if (!ready() || !to) return { skipped: true };
  try { await transport().sendMail({ from: process.env.MAIL_FROM || ('CHA&I <' + process.env.SMTP_USER + '>'), to, subject, html, text: txt }); return { sent: true }; }
  catch (e) { console.error('mail', e && e.message); return { sent: false }; }
}

/* 1) 주문 확인 (전자상거래법: 계약 내용을 전자문서로 제공) */
function orderConfirm(o) {
  const rows = [['주문번호', o.id], ['상품', o.name], ['결제 금액', won(o.amount) + ' (부가세 포함)'], ['결제일', new Date(o.paidAt || Date.now()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })], ['결제 수단', o.method || '-']];
  if (o.course) rows.push(['수강 기한', '강의를 제공하는 동안 기간 제한 없이 (환불 계산은 수강 시작일부터 30일 기준)']);
  if (o.kit) rows.push(['차 키트', '내 학습 → 주문 내역에서 배송지를 넣어 주시면 보내 드려요']);
  rows.push(['취소·환불', o.refundRule || '취소·환불정책 기준']);
  const body = '<p style="margin:0">주문해 주셔서 고마워요. 아래 내용으로 계약이 성립했어요.' + (o.test ? ' <b>(테스트 결제라 실제로 청구되지 않았어요)</b>' : '') + '</p>';
  const foot = '<p style="margin:0"><a href="' + SITE + '/my" style="display:inline-block;background:#26313D;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px">내 학습으로</a></p><p style="font-size:13px;color:#6B727A">환불은 내 학습 → 주문 내역 → 환불 신청에서 할 수 있고, 금액은 <a href="' + SITE + '/refund">취소·환불정책</a>에 따라 자동으로 계산돼요.</p>';
  return send(o.email, '[CHA&I] 주문 확인 · ' + o.name, wrap('주문이 완료됐어요', rows, body, foot), text('주문이 완료됐어요', rows, [SITE + '/my']));
}
/* 2) 환불 완료 */
function refundDone(o) {
  const rows = [['주문번호', o.id], ['상품', o.name], ['환불 금액', won(o.refunded)], ['누적 환불', won(o.total) + ' / ' + won(o.amount)], ['기준', o.reason || '-']];
  const body = '<p style="margin:0">환불을 처리했어요. 카드 결제는 카드사 사정으로 반영까지 3~7일 걸릴 수 있어요.' + (o.revoked ? ' 이 주문의 수강권은 회수됐어요.' : '') + '</p>';
  return send(o.email, '[CHA&I] 환불 완료 · ' + won(o.refunded), wrap('환불이 완료됐어요', rows, body), text('환불이 완료됐어요', rows));
}
/* 3) 기업 초대 */
function companyInvite(p) {
  const body = '<p style="margin:0">' + esc(p.company) + '에서 CHA&amp;I 강의에 초대했어요. 아래 버튼으로 <b>' + esc(p.email) + '</b> 주소로 가입하거나 로그인하면 회사에서 배정한 강의가 내 학습에 들어가요.</p>';
  const foot = '<p style="margin:16px 0 0"><a href="' + SITE + '/login?mode=signup" style="display:inline-block;background:#26313D;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px">가입하고 시작하기</a></p><p style="font-size:13px;color:#6B727A">회사에는 강의별 진도율과 수료 여부만 보여요. 질문·실습 내용은 보이지 않아요.</p>';
  return send(p.email, '[CHA&I] ' + p.company + '에서 강의에 초대했어요', wrap('강의에 초대받았어요', [], body, foot), text(p.company + '에서 CHA&I 강의에 초대했어요', [], [SITE + '/login?mode=signup']));
}
module.exports = { ready, orderConfirm, refundDone, companyInvite };
