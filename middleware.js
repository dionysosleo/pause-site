/* 공유 미리보기(카카오톡·페이스북·슬랙 등): 링크 미리보기 봇은 화면 코드를 실행하지 않아서
   상세 페이지마다 제목·설명·사진을 담은 짧은 HTML을 따로 돌려줘요. 사람이 열면 평소 화면 그대로.
   og-map.json 은 chaand-ops/scripts/og/og_map.py 로 만들어요 (워크샵·강의를 고친 뒤 다시 실행). */
import MAP from './og-map.json';

export const config = { matcher: ['/w-:id', '/c-:id', '/en/w-:id', '/en/c-:id'] };

const BOT = /kakaotalk-scrap|facebookexternalhit|facebot|twitterbot|slackbot|linkedinbot|discordbot|telegrambot|whatsapp|line\/|yeti|daum|pinterest|skypeuripreview|embedly|iframely/i;
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default function middleware(request) {
  const url = new URL(request.url);
  /* ?_og=1 : 사람이 미리보기 결과를 확인할 때 */
  if (!BOT.test(request.headers.get('user-agent') || '') && url.searchParams.get('_og') !== '1') return;
  const en = url.pathname.startsWith('/en/');
  const key = en ? url.pathname.slice(3) : url.pathname;
  const p = (MAP[en ? 'en' : 'ko'] || {})[key];
  if (!p) return;
  const ua = request.headers.get('user-agent') || '';
  /* 카카오톡은 webp 미리보기가 안 뜰 수 있어 jpg 사진이 없으면 대표 이미지로 */
  const base = 'https://www.chaand.ai', page = base + url.pathname, img = base + '/' + (/\.webp$/.test(p.i) && /kakaotalk/i.test(ua) ? 'og.png' : p.i);
  const title = p.t + ' — CHA&I';
  const html = '<!doctype html><html lang="' + (en ? 'en' : 'ko') + '"><head><meta charset="utf-8">' +
    '<title>' + esc(title) + '</title><meta name="description" content="' + esc(p.d) + '"><link rel="canonical" href="' + page + '">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="CHA&amp;I"><meta property="og:title" content="' + esc(title) + '">' +
    '<meta property="og:description" content="' + esc(p.d) + '"><meta property="og:url" content="' + page + '"><meta property="og:image" content="' + img + '">' +
    '<meta property="og:locale" content="' + (en ? 'en_US' : 'ko_KR') + '"><meta name="twitter:card" content="summary_large_image">' +
    '</head><body><a href="' + page + '">' + esc(title) + '</a></body></html>';
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' } });
}
