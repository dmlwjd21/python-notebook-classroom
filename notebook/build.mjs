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
