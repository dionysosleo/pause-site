/* 지금 쓰는 PG사 고르기. Vercel 환경 변수 PG_PROVIDER (기본 toss) */
const P = { toss: require('./toss.js') };
module.exports = P[String(process.env.PG_PROVIDER || 'toss').toLowerCase()] || P.toss;
