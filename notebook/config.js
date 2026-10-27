// 플랫폼 설정.
// 학교별 값(googleClientId, allowedDomain)은 여기서 고치지 말고 Vercel 환경 변수로 넣으세요.
//   GOOGLE_CLIENT_ID → googleClientId,  SCHOOL_DOMAIN → allowedDomain
//   (배포할 때 build.mjs가 자동으로 채워 넣어요. 설치 안내: docs/설치_안내.md)
window.PYCLASS_CONFIG = {
  appName: '파이썬 노트북',
  // 브라우저에서 파이썬을 실행하는 Pyodide 런타임 (Python 3.12)
  pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
  // 셀 하나에서 보여줄 최대 출력 글자 수 (무한 print 방지)
  maxOutputChars: 100000,

  // ---- 구글 클래스룸 연동 ----
  // 구글 클라우드 콘솔에서 만든 OAuth 웹 클라이언트 ID. 비어 있으면 데모 모드(연습용 데이터)로 동작한다.
  googleClientId: '',
  // 학교 구글 도메인 (예: 'school.sen.hs.kr'). 로그인 화면에서 이 도메인 계정을 먼저 보여준다.
  allowedDomain: '',
  // 배포 주소. 비워 두면 지금 열린 주소를 쓴다 (보통 비워 두면 됨).
  appUrl: '',
};
