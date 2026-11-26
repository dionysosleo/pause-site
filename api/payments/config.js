/* 결제창에 필요한 공개 값만 돌려줌 (클라이언트 키·모드). 비밀키는 절대 내보내지 않음. */
const KEYS = require('./_keys.js');
module.exports = (req, res) => {
  const { client, mode } = KEYS();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(JSON.stringify({ clientKey: client, mode }));
};
