// Vercel이 배포할 때 실행하는 설정 스크립트.
// 학교마다 다른 값(구글 클라이언트 ID, 학교 도메인)을 Vercel 환경 변수로 받아 config.js에 넣는다.
// 그래서 다른 학교 선생님은 코드를 고치지 않고 Vercel 화면에서 값만 입력하면 된다.
import fs from 'node:fs';

const ENV_TO_KEY = {
  GOOGLE_CLIENT_ID: 'googleClientId',
  SCHOOL_DOMAIN: 'allowedDomain',
  APP_NAME: 'appName',
  APP_URL: 'appUrl',
};

const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
if (!clientId) {
  console.log('GOOGLE_CLIENT_ID가 없어 데모 모드로 배포해요 (연습용 데이터).');
} else if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
  throw new Error('GOOGLE_CLIENT_ID 형식이 이상해요. "….apps.googleusercontent.com"으로 끝나는 클라이언트 ID를 넣어 주세요.');
}

let src = fs.readFileSync('config.js', 'utf8');
for (const [env, key] of Object.entries(ENV_TO_KEY)) {
  const value = (process.env[env] || '').trim();
  if (!value) continue;
  const pattern = new RegExp(`(\\n\\s*${key}:\\s*)(['"])[^'"]*\\2`);
  if (!pattern.test(src)) throw new Error(`config.js에서 ${key} 항목을 찾지 못했어요`);
  src = src.replace(pattern, (_, head) => `${head}${JSON.stringify(value)}`);
  console.log(`설정 적용: ${key} ← 환경 변수 ${env}`);
}

fs.writeFileSync('config.js', src);

// ---- 개인정보 처리방침(privacy.html)의 학교별 빈칸 채우기
// SCHOOL_NAME(학교 이름), PRIVACY_DATE(시행일, 예: 2026-11-01), PRIVACY_OFFICER(보호책임자, 예: 교장), PRIVACY_CONTACT(연락처)
const PRIVACY_KEYS = ['SCHOOL_NAME', 'PRIVACY_DATE', 'PRIVACY_OFFICER', 'PRIVACY_CONTACT'];
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const formatDate = (v) => {
  const m = v.match(/^(\d{4})-?(\d{1,2})-?(\d{1,2})$/);
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : v;
};

if (fs.existsSync('privacy.html')) {
  let html = fs.readFileSync('privacy.html', 'utf8');
  let filled = 0;
  for (const key of PRIVACY_KEYS) {
    let value = (process.env[key] || '').trim();
    if (!value) continue;
    if (key === 'PRIVACY_DATE') value = formatDate(value);
    const pattern = new RegExp(`<span class="fill" data-key="${key}">[^<]*</span>`, 'g');
    html = html.replace(pattern, escapeHtml(value));
    filled += 1;
    console.log(`처리방침 적용: ${key}`);
  }
  // 학교별 빈칸을 모두 채웠으면 "초안" 안내를 지운다
  if (filled === PRIVACY_KEYS.length) html = html.replace(/<p class="draft" id="draftNotice">[\s\S]*?<\/p>\s*/, '');
  else console.log('처리방침에 아직 채우지 않은 칸이 있어 "초안" 안내를 남겨요.');
  fs.writeFileSync('privacy.html', html);
}
