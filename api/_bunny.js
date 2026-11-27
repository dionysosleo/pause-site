/* Bunny Stream 연결 (서버 전용). 값은 Vercel 환경 변수:
   BUNNY_LIBRARY_ID(라이브러리 번호), BUNNY_STREAM_API_KEY(라이브러리 API 키), BUNNY_TOKEN_KEY(Security → Token Authentication 키)
   값이 없으면 configured()가 false → 화면에는 '영상 연결 전'으로 표시. */
const crypto = require('crypto');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function cfg() { return { lib: process.env.BUNNY_LIBRARY_ID || '', key: process.env.BUNNY_STREAM_API_KEY || '', token: process.env.BUNNY_TOKEN_KEY || '' }; }
function configured() { const c = cfg(); return !!(c.lib && c.key && c.token); }
/* 재생 주소: 서명과 만료 시각이 붙은 임베드 주소 (기본 4시간) */
function embedUrl(videoId, ttl) {
  const c = cfg(), exp = Math.floor(Date.now() / 1000) + (ttl || 4 * 3600);
  const q = 'token=' + sha256(c.token + videoId + exp) + '&expires=' + exp + '&autoplay=false&preload=true&responsive=true';
  return { url: 'https://iframe.mediadelivery.net/embed/' + encodeURIComponent(c.lib) + '/' + encodeURIComponent(videoId) + '?' + q, expires: exp };
}
/* 업로드 준비: 영상 자리를 만들고, 브라우저가 Bunny로 바로 올릴 수 있는 서명(TUS)을 줌 (1시간) */
async function createUpload(title) {
  const c = cfg();
  const r = await fetch('https://video.bunnycdn.com/library/' + encodeURIComponent(c.lib) + '/videos', { method: 'POST', headers: { AccessKey: c.key, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ title: String(title || 'lesson').slice(0, 120) }) });
  const v = await r.json().catch(() => ({}));
  if (!r.ok || !v.guid) throw new Error('BUNNY_CREATE ' + r.status);
  const expire = Math.floor(Date.now() / 1000) + 3600;
  return { endpoint: 'https://video.bunnycdn.com/tusupload', libraryId: c.lib, videoId: v.guid, expire, signature: sha256(c.lib + c.key + expire + v.guid) };
}
/* 인코딩 상태: 0 대기 1 업로드됨 2 처리 중 3 변환 중 4 완료 5 오류 */
async function status(videoId) {
  const c = cfg();
  const r = await fetch('https://video.bunnycdn.com/library/' + encodeURIComponent(c.lib) + '/videos/' + encodeURIComponent(videoId), { headers: { AccessKey: c.key, accept: 'application/json' } });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('BUNNY_STATUS ' + r.status);
  return { status: v.status, length: v.length || 0, progress: v.encodeProgress || 0 };
}
module.exports = { configured, embedUrl, createUpload, status };
