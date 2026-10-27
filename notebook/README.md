# notebook/ — 플랫폼 코드 (개발자용 메모)

설치·사용 안내는 [docs/설치_안내.md](../docs/설치_안내.md)를 보세요. 이 문서는 코드를 고치려는 분을 위한 설명입니다.

## 로컬에서 실행

```bash
python notebook/serve.py
```

http://localhost:8000 (노트북), http://localhost:8000/review.html (교사용 도구).
`config.js`에 클라이언트 ID가 없으면 데모 모드(연습용 반·학생, 브라우저 localStorage에 저장)로 동작합니다.
실제 구글 연동을 로컬에서 시험하려면 `?demo` 없이, `config.js`의 `googleClientId`·`allowedDomain`을 잠시 채우고
구글 클라이언트의 "승인된 JavaScript 원본"에 `http://localhost:8000`을 추가하세요. (커밋하지 말 것)

## 배포 설정

- Vercel 프로젝트의 **Root Directory = `notebook`**
- `vercel.json` → 빌드 때 `build.mjs` 실행: 환경 변수 `GOOGLE_CLIENT_ID`, `SCHOOL_DOMAIN`(선택: `APP_NAME`, `APP_URL`)을 `config.js`에 넣음
- `.vercelignore`로 문서·로컬 서버·`.ipynb`·`.env*`는 배포에서 제외

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html`, `styles.css` | 학생 노트북 화면 |
| `app.js` | 셀 편집, 실행 대기열, 저장, `.ipynb` 열기/다운로드, 잠금 |
| `kernel-worker.js` | Pyodide로 파이썬 실행 (Web Worker, 중단 시 통째로 재시작) |
| `sw.js` | `input()` 입력값을 커널로 전달하는 서비스 워커 |
| `integrity.js` | 작성 과정 기록(학생)과 기록 분석(교사) |
| `google.js` | 클래스룸·드라이브·시트 API, 설정 전에는 데모 저장소 |
| `assignment.js` | 과제 모드(`?c=반&t=문제파일`)·수업 자료 모드(`?m=파일`): 불러오기, 드라이브 자동 저장, 제출 |
| `review.html`, `review.js`, `review.css` | 교사용 도구: 제출물 검토, 템플릿 설정 |
| `deploy.js` | 교사용: 과제·수업 자료 배포 |
| `grade.js`, `grade-worker.js` | 교사용: 제출물 수집·자동 채점 (채점은 별도 Worker) |
| `grader_core.py` | 채점 엔진 (Pyodide 안에서 실행, 그래프 객체 검사) |
| `config.js`, `build.mjs`, `vercel.json` | 설정과 배포 |
| `serve.py` | 로컬 테스트용 서버 |

## 데이터가 저장되는 곳

| 데이터 | 위치 |
|---|---|
| 문제·실습 파일 | 교사 드라이브 `파이썬 노트북 과제 (문제 파일)` (학교 도메인 읽기 공유) |
| 채점 기준 파일 | 같은 폴더, 공유 안 함 |
| 학생 과제 파일 | 학생 드라이브 `파이썬 노트북 과제` → 제출 시 클래스룸 첨부 |
| 학생 수업 실습 파일 | 학생 드라이브 `파이썬 노트북 수업` |
| 작성 기록 | 각 `.ipynb`의 `metadata.pyclass.record` |
| 성적 | 교사 드라이브 시트 `파이썬 노트북 성적 연도` |
| 로그인 없는 연습 | 브라우저 localStorage `pyclass:notebook:v1` |

## 알려진 제한

- 학생 PC의 파일 업로드(`open()`으로 읽기)는 아직 지원하지 않습니다.
- 실행 중단 시 코랩과 달리 변수가 모두 초기화됩니다.
- 학생에게 가는 피드백 글은 자동 전달되지 않습니다 (클래스룸 비공개 댓글로 직접).
- 작성 기록은 브라우저 개발자 도구로 지우거나 바꿀 수 있습니다. 바꾸면 대부분 "기록 불일치"·"기록 없음"으로 드러나지만 완벽한 차단은 아닙니다.
