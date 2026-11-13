# 문의·제안서 접수 연결하기 (구글 시트)

사이트의 "제안서 받기"와 "도입 문의" 폼은 `index.html`의 `LEAD_CONFIG`를 채우면 실제로 접수돼요.

```js
var LEAD_CONFIG = { endpoint: '', proposalUrl: '' };
```

## 1. 구글 시트 만들기 (endpoint)
1. 새 구글 시트를 만들고 첫 행에 적기: `at | kind | company | name | email | role | phone | size | program | when | roles | access | proposal | msg | page`
2. 확장 프로그램 → Apps Script → 아래 코드 붙여 넣기 (알림 받을 메일 주소 수정)

```js
const NOTIFY = 'you@example.com';
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(h => d[h] || ''));
  MailApp.sendEmail(NOTIFY, `[PAUSE] ${d.kind} · ${d.company} ${d.name}`, JSON.stringify(d, null, 2));
  return ContentService.createTextOutput('ok');
}
```
3. 배포 → 새 배포 → 유형 "웹 앱" → 실행: 나 / 액세스: 모든 사용자 → 배포
4. 나온 웹 앱 URL을 `endpoint`에 넣기

## 2. 제안서 PDF (proposalUrl)
1. Claude 슬라이드 "PAUSE 기업 제안서"에서 PDF로 내보내기
2. 저장소 루트에 `PAUSE-proposal.pdf`로 올리기
3. `proposalUrl: '/PAUSE-proposal.pdf'`

endpoint가 비어 있으면 폼은 내용을 복사해 메일로 보내는 방식으로 동작하고, proposalUrl이 비어 있으면 "메일로 보내 드려요"라고 안내해요.
