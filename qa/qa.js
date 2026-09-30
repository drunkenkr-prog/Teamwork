// 0번 검수팀장 QA 하네스: index.html을 띄우고 모든 버튼을 눌러 본다. API는 목(mock)으로 대체.
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = process.argv[2] || '/home/user/Teamwork';
const SHOTS = path.join(__dirname, 'shots');
const findings = [];
const note = (sev, msg) => { findings.push({sev, msg}); console.log(`[${sev}] ${msg}`); };
const ok = (msg) => console.log(`  ok  ${msg}`);

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(b); });
  }).listen(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, permissions:['clipboard-read','clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', async d => { console.log(`  dialog(${d.type()}): ${d.message()}`); await d.accept(d.type()==='prompt' ? '이름변경됨' : undefined); });

  // 외부 리소스 차단 + API 목
  const apiLog = [];
  let mode = 'ok';
  await page.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
  await page.route(/api\.openai\.com/, async r => {
    const body = r.request().postDataJSON(); apiLog.push({p:'openai', body});
    if (mode==='fail') return r.fulfill({status:401, contentType:'application/json', body:JSON.stringify({error:{message:'Incorrect API key provided'}})});
    if (mode==='html') return r.fulfill({status:502, contentType:'text/html', body:'<html>Bad gateway</html>'});
    if (mode==='hang' || mode==='hangopenai') return; // never respond
    if (mode==='nullcontent') return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({choices:[{message:{content:null, refusal:'거부'}}]})});
    const txt = mode==='md' ? '# 제목\n\n**굵게** 그리고 `code`\n\n- 항목1\n- 항목2\n\n본문 사이\n- 항목3\n\n```js\nconst a = 1 < 2 && "x";\n```\n\n1. 번호\n2. 목록\n\n마무리 <script>alert(1)</script>' : '기획 답변: ' + body.messages[1].content.slice(0,60);
    return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({choices:[{message:{content:txt}}]})});
  });
  await page.route(/api\.anthropic\.com/, async r => {
    const body = r.request().postDataJSON(); apiLog.push({p:'anthropic', body, headers:r.request().headers()});
    if (mode==='fail') return r.fulfill({status:401, contentType:'application/json', body:JSON.stringify({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}})});
    if (mode==='html') return r.fulfill({status:502, contentType:'text/html', body:'<html>Bad gateway</html>'});
    if (mode==='hang') return;
    if (mode==='refusal') return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({content:[], stop_reason:'refusal', stop_details:{type:'refusal',category:'general_harms'}})});
    if (mode==='maxtok') return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({content:[{type:'text',text:'잘린 답변 시작…'}], stop_reason:'max_tokens'})});
    return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({content:[{type:'text',text:'구현 답변: ' + body.messages[0].content.slice(0,60)}], stop_reason:'end_turn'})});
  });
  await page.route(/generativelanguage\.googleapis\.com/, async r => {
    const body = r.request().postDataJSON(); apiLog.push({p:'google', body, url:r.request().url()});
    if (mode==='fail') return r.fulfill({status:400, contentType:'application/json', body:JSON.stringify({error:{message:'API key not valid'}})});
    if (mode==='html') return r.fulfill({status:502, contentType:'text/html', body:'<html>Bad gateway</html>'});
    if (mode==='hang') return;
    if (mode==='safety') return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({candidates:[{finishReason:'SAFETY', safetyRatings:[]}]})});
    if (mode==='blocked') return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({promptFeedback:{blockReason:'SAFETY'}})});
    return r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({candidates:[{content:{parts:[{text:'조사 답변: ' + body.contents[0].parts[0].text.slice(0,60)}]}}]})});
  });

  const shot = async (n) => page.screenshot({path: path.join(SHOTS, n + '.png')});
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('aiteam.v1')));
  const wait = (ms) => page.waitForTimeout(ms);

  await page.goto(url);
  await shot('01-empty');
  ok('첫 화면 로드');

  // 1) 키 없이 전송 → 설정 시트 열려야 함
  await page.fill('#input', '테스트');
  await page.click('#send');
  await wait(300);
  if (!(await page.$('#sheetSettings.on'))) note('BUG', '키 없이 전송 시 설정 시트가 열리지 않음');
  else ok('키 없이 전송 → 설정 시트 열림 + 토스트');
  if ((await page.inputValue('#input')) !== '테스트') note('BUG', '키 없음 안내 후 입력값이 사라짐');
  await shot('02-settings');

  // 2) 설정 저장 (3키)
  await page.fill('#k_openai', 'sk-test'); await page.fill('#k_anthropic', 'sk-ant-test'); await page.fill('#k_google', 'AIza-test');
  await page.fill('#m_openai', ''); // 빈 모델 → 기본값 복원돼야 함
  await page.click('#saveSettings'); await wait(300);
  let S = await state();
  if (S.keys.openai !== 'sk-test') note('BUG', '설정 저장 후 키가 저장되지 않음');
  if (!S.models.openai) note('BUG', '빈 모델명 저장 시 기본값 복원 안 됨'); else ok('빈 모델명 → 기본값 ' + S.models.openai);
  console.log('  models:', JSON.stringify(S.models));

  // 3) 병렬 모드 전송
  await page.fill('#input', '매입가 1000원, 매출가 얼마로 잡을까?');
  await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.card .copy:not([hidden])').length === 3, null, {timeout:5000}).catch(()=>note('BUG','병렬 모드에서 3장 카드가 모두 채워지지 않음'));
  await shot('03-parallel');
  S = await state();
  const lastUser = apiLog.find(a=>a.p==='openai').body.messages[1].content;
  if (/최근 논의/.test(lastUser) && /매입가 1000원/.test(lastUser.split('[요청]')[0])) note('BUG', 'contextBlock: 지금 막 보낸 질문이 "최근 논의"에 중복으로 들어감 (log.push 후 contextBlock 호출)');
  const parAnth = apiLog.find(a=>a.p==='anthropic').body.messages[0].content;
  if (!/스스로 검수하라/.test(parAnth) || !/역마진/.test(parAnth)) note('BUG', '병렬 모드 가격 질문에서 구현 팀원에게 역마진 검수 지시가 없음');
  else ok('병렬 모드 가격 질문 → 구현 자기 검수 지시');
  const aHeaders = apiLog.find(a=>a.p==='anthropic').headers;
  ok('anthropic headers: ' + JSON.stringify({v:aHeaders['anthropic-version'], d:aHeaders['anthropic-dangerous-direct-browser-access']}));
  const gUrl = apiLog.find(a=>a.p==='google').url;
  if (/[?&]key=/.test(gUrl)) note('WARN', 'Gemini 키가 URL 쿼리스트링으로 전송됨 (x-goog-api-key 헤더 권장)');
  if (!(await page.$('#send:not([disabled])'))) note('BUG', '전송 완료 후 보내기 버튼이 계속 비활성');

  // 4) 복사 버튼
  await page.click('.card .copy:not([hidden]) >> nth=0'); await wait(200);
  const toastTxt = await page.textContent('#toast');
  ok('복사 토스트: ' + toastTxt);

  // 5) 토론 모드 (3키)
  await page.click('.mode[data-mode="debate"]');
  S = await state(); if (S.mode !== 'debate') note('BUG', '모드 전환이 저장되지 않음');
  const sel = await page.getAttribute('.mode[data-mode="debate"]', 'aria-selected');
  if (sel !== 'true') note('A11Y', 'role=tab 에 aria-selected 없음');
  apiLog.length = 0;
  await page.fill('#input', '거래처 흥정 시스템 설계');
  await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.seq').length >= 4 && document.querySelectorAll('.card .copy:not([hidden])').length >= 7, null, {timeout:8000}).catch(()=>note('BUG','토론 모드 4단계가 모두 완료되지 않음'));
  await shot('04-debate');
  const seqs = await page.$$eval('.seq', els => els.map(e=>e.textContent));
  ok('토론 순서: ' + seqs.join(' → '));
  const finalPrompt = apiLog[apiLog.length-1].body.messages[1].content;
  if (/undefined/.test(finalPrompt)) note('BUG', '토론 결론 프롬프트에 undefined 포함');
  if (!/\[기획 초안 \(1단계, 네가 썼다\)\]\n기획 답변/.test(finalPrompt)) note('BUG', '결론 담당(기획)이 자기 1단계 초안을 못 봄: ' + finalPrompt.slice(0,200));
  else ok('결론 프롬프트에 기획 초안 포함');

  // 6) 토론 모드: openai 키 없음 → undefined 프롬프트?
  await page.click('#btnSettings'); await page.fill('#k_openai', ''); await page.click('#saveSettings'); await wait(200);
  apiLog.length = 0;
  await page.fill('#input', '기획 없이 토론'); await page.click('#send');
  await wait(1500);
  const anth = apiLog.find(a=>a.p==='anthropic');
  if (anth && /undefined/.test(anth.body.messages[0].content)) note('BUG', '토론 모드에서 기획(OpenAI) 키가 없으면 구현 프롬프트에 "[기획의 초안]\\nundefined" 가 들어감');
  const goog = apiLog.find(a=>a.p==='google');
  if (goog && /undefined/.test(goog.body.contents[0].parts[0].text)) note('BUG', '토론 모드에서 조사 프롬프트에도 undefined 포함');
  const hasConclusion = (await page.$$eval('.seq', els => els.map(e=>e.textContent))).includes('결론');
  const seqNoOpenai = await page.$$eval('.turn:last-child .seq', els=>els.map(e=>e.textContent));
  console.log('  기획 없이 토론 순서:', seqNoOpenai.join(' → '));
  if (!seqNoOpenai.includes('결론')) note('BUG', '기획(OpenAI) 키가 없으면 토론 결론 단계가 사라짐 (다른 팀원이 대신 맡아야 함)');
  // 키 1개만: 결론 단계는 생략되어야 함
  await page.click('#btnSettings'); await page.fill('#k_google', ''); await page.click('#saveSettings'); await wait(200);
  await page.fill('#input', '혼자 토론'); await page.click('#send'); await wait(1200);
  const seqSolo = await page.$$eval('.turn:last-child .seq', els=>els.map(e=>e.textContent));
  console.log('  1인 토론 순서:', seqSolo.join(' → '));
  if (!seqSolo.includes('검수')) note('BUG', '참여자가 1명일 때 자기 검수 단계가 없음 (키 1개 사용자는 역마진 검수를 못 받음)');
  else { const soloPrompt = apiLog.filter(a=>a.p==='anthropic').pop().body.messages[0].content; if (!/네가 쓴 것이다/.test(soloPrompt) || !/역마진/.test(soloPrompt)) note('BUG', '자기 검수 프롬프트에 검수 지시가 없음'); else ok('1인 참여 자기 검수 단계'); }
  await page.click('#btnSettings'); await page.fill('#k_google', 'AIza-test'); await page.click('#saveSettings'); await wait(200);
  await shot('05-debate-no-openai');
  // 키 복구
  await page.click('#btnSettings'); await page.fill('#k_openai', 'sk-test'); await page.click('#saveSettings'); await wait(200);

  // 7) 에러 응답 (401)
  mode = 'fail';
  await page.click('.mode[data-mode="parallel"]');
  await page.fill('#input', '에러 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.err').length === 3, null, {timeout:5000}).catch(()=>note('BUG','401 에러가 3장 카드에 표시되지 않음'));
  const errTxt = await page.$$eval('.err', els=>els.map(e=>e.textContent));
  ok('401 표시: ' + errTxt.join(' | '));
  await shot('06-errors');

  // 8) 비-JSON 응답 (502 HTML)
  mode = 'html';
  await page.fill('#input', '502 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .err').length === 3, null, {timeout:5000}).catch(()=>note('BUG','502 HTML 응답 처리 실패'));
  const err502 = await page.$$eval('.turn:last-child .err', els=>els.map(e=>e.textContent));
  if (err502.some(t=>/Unexpected token|JSON/.test(t))) note('BUG', '비-JSON 응답(502 HTML) 시 사용자에게 "Unexpected token" 같은 파서 오류가 그대로 노출됨: ' + err502[0]);
  else ok('502 표시: ' + err502.join(' | '));

  // 9) Gemini 안전필터 (content 없음) / OpenAI null content / Anthropic refusal, max_tokens
  mode = 'safety';
  await page.fill('#input', '안전필터 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .body:not(:has(.dots))').length === 3, null, {timeout:5000}).catch(()=>{});
  const safe = await page.$$eval('.turn:last-child .card', els=>els.map(e=>e.querySelector('.body').textContent.trim()));
  if (safe.some(t=>/Cannot read|undefined/.test(t))) note('BUG', 'Gemini finishReason=SAFETY(content 없음) 시 TypeError 노출: ' + safe.find(t=>/Cannot read|undefined/.test(t)));
  else ok('safety 표시: ' + safe.join(' | '));
  mode = 'blocked';
  await page.fill('#input', '차단 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .body:not(:has(.dots))').length === 3, null, {timeout:5000}).catch(()=>{});
  ok('blocked 표시: ' + (await page.$$eval('.turn:last-child .card', els=>els.map(e=>e.querySelector('.body').textContent.trim()))).join(' | '));
  mode = 'nullcontent';
  await page.fill('#input', 'null 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .body:not(:has(.dots))').length === 3, null, {timeout:5000}).catch(()=>{});
  const nul = await page.$$eval('.turn:last-child .card', els=>els.map(e=>e.querySelector('.body').textContent.trim()));
  if (nul.some(t=>t==='null')) note('BUG', 'OpenAI content:null(refusal) 시 카드에 "null" 문자열 표시');
  else ok('null content 표시: ' + nul.join(' | '));
  mode = 'refusal';
  await page.fill('#input', 'refusal 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .body:not(:has(.dots))').length === 3, null, {timeout:5000}).catch(()=>{});
  const ref = await page.$$eval('.turn:last-child .card', els=>els.map(e=>e.querySelector('.body').textContent.trim()));
  if (ref.some(t=>t==='')) note('BUG', 'Anthropic stop_reason=refusal(content 비어있음) 시 빈 카드 표시');
  else ok('refusal 표시: ' + ref.join(' | '));
  mode = 'maxtok';
  await page.fill('#input', 'max_tokens 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .body:not(:has(.dots))').length === 3, null, {timeout:5000}).catch(()=>{});
  const mt = await page.$$eval('.turn:last-child .card', els=>els.map(e=>e.querySelector('.body').textContent.trim()));
  if (!mt.some(t=>/잘|max_tokens|길이/.test(t) && /잘렸|한도|max_tokens/.test(t))) note('WARN', 'Anthropic stop_reason=max_tokens 일 때 잘렸다는 안내 없음');
  const anthBody = apiLog.filter(a=>a.p==='anthropic').pop().body;
  console.log('  anthropic body keys:', Object.keys(anthBody).join(','), 'max_tokens=', anthBody.max_tokens, 'model=', anthBody.model);

  // 10) 마크다운 렌더 확인
  mode = 'md';
  await page.fill('#input', '마크다운 테스트'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .copy:not([hidden])').length === 3, null, {timeout:5000}).catch(()=>{});
  const mdHtml = await page.$eval('.turn:last-child .card .body', e=>e.innerHTML);
  console.log('  md html:', mdHtml.slice(0,600));
  if (/<p>\s*<pre>/.test(mdHtml) || /<p>\u0000/.test(mdHtml)) note('BUG', 'md(): 코드블록이 <p> 안에 들어감 (플레이스홀더가 \\u0000 이라 <pre 판정 실패)');
  if (/<ul><li>항목1<\/li>\n<li>항목2<\/li>\n\n본문/.test(mdHtml) || /<p>본문 사이<br><li>/.test(mdHtml)) note('BUG', 'md(): 목록 사이에 문단이 끼면 <ul>이 문단을 삼키거나 <li>가 <p> 안에 남음');
  if (/<script>/.test(mdHtml)) note('SEC', 'md(): script 태그가 이스케이프되지 않음');
  else ok('md(): <script> 이스케이프됨');
  await shot('07-markdown');

  // 11) 응답 무한 대기 (hang) → 중지 버튼으로 빠져나올 수 있어야 함
  mode = 'hang';
  await page.fill('#input', '멈춤 테스트'); await page.click('#send'); await wait(1200);
  const stopBtn = await page.$('#send.stop');
  const disabledWhileHang = await page.$('#send[disabled]');
  if (!stopBtn) note('BUG', '응답이 오지 않을 때 중지 수단이 없음' + (disabledWhileHang ? ' (보내기 버튼 영구 비활성)' : ''));
  else {
    await page.click('#send'); await wait(400);
    const stopped = await page.$$eval('.turn:last-child .err', els=>els.map(e=>e.textContent));
    if (!stopped.length || !stopped.every(t=>/중지/.test(t))) note('BUG', '중지 후 카드에 중지 표시가 없음: ' + JSON.stringify(stopped));
    else ok('중지 버튼 동작: ' + stopped[0]);
    if (await page.$('#send.stop')) note('BUG', '중지 후에도 버튼이 중지 상태로 남음');
  }
  await shot('08-hang');
  mode = 'ok';

  // 11b) 전송 중 Ctrl+Enter 는 요청을 끊으면 안 된다
  mode = 'hang';
  await page.fill('#input', '연타 테스트'); await page.click('#send'); await wait(300);
  await page.fill('#input', '두번째'); await page.press('#input', 'Control+Enter'); await wait(300);
  if (!(await page.$('#send.stop'))) note('BUG', '전송 중 Ctrl+Enter 가 진행 중인 요청을 끊어버림');
  else ok('전송 중 Ctrl+Enter 무시');
  await page.click('#send'); await wait(300); await page.fill('#input', '');

  // 11c) 타임아웃은 요청 하나마다: 토론 모드에서 1단계가 시간 초과여도 2·3·결론은 정상
  await page.evaluate(() => { REQUEST_TIMEOUT_MS = 1500; });
  mode = 'hangopenai';
  await page.click('.mode[data-mode="debate"]');
  await page.fill('#input', '타임아웃 테스트'); await page.click('#send');
  await page.waitForFunction(() => !document.querySelector('#send.stop'), null, {timeout:15000}).catch(()=>note('BUG','타임아웃 후 버튼이 복구되지 않음'));
  const toCards = await page.$$eval('.turn:last-child .card', els=>els.map(e=>(e.querySelector('.seq')?.textContent||'')+':'+e.querySelector('.body').textContent.trim().slice(0,30)));
  console.log('  타임아웃 토론:', JSON.stringify(toCards));
  if (!/^1:응답 시간 초과/.test(toCards[0]||'')) note('BUG', '1단계 시간 초과 표시 없음');
  // 결론은 다시 기획(OpenAI)이 맡으므로 이 목에서는 결론도 시간 초과가 정상. 2·3단계가 살아 있어야 한다.
  if (toCards.length < 4 || toCards.slice(1,3).some(t=>/시간 초과|중지/.test(t))) note('BUG', '한 단계 타임아웃이 다음 단계까지 끊음 (요청 묶음 단위 타임아웃)');
  else ok('단계별 타임아웃 격리 (2·3단계 정상, 결론은 OpenAI 무응답이라 시간 초과가 정상)');
  await page.evaluate(() => { REQUEST_TIMEOUT_MS = 180000; });
  await page.click('.mode[data-mode="parallel"]');
  mode = 'ok';

  // 11d) 종료된 모델명을 설정에 넣으면 자동 교체, 종료 예정 모델은 경고
  await page.click('#btnSettings'); await page.fill('#m_anthropic', 'claude-3-5-sonnet-20241022'); await page.fill('#m_google', 'gemini-2.5-flash'); await page.click('#saveSettings'); await wait(300);
  S = await state();
  if (S.models.anthropic !== 'claude-opus-5-5') note('BUG', '종료된 Anthropic 모델명이 자동 교체되지 않음: ' + S.models.anthropic); else ok('종료 모델 자동 교체');
  const sunsetToast = await page.textContent('#toast');
  if (!/2026-10-16/.test(sunsetToast)) note('BUG', '종료 예정 모델(gemini-2.5-flash) 경고 토스트 없음: ' + sunsetToast); else ok('종료 예정 경고: ' + sunsetToast);
  await page.click('#btnSettings'); await page.fill('#m_google', ''); await page.click('#saveSettings'); await wait(300);

  // 12) 프로젝트 보드
  await page.click('#btnBoard'); await wait(300);
  await page.fill('#p_name', '관 파이프 상사'); await page.fill('#p_prog', '250'); await page.fill('#p_stack', 'Unity 6 / C#');
  await page.fill('#p_rules', '판매가 ≥ 원가 + 수수료 5%'); await page.fill('#p_now', '매입·매출 계산'); await page.fill('#p_next', '흥정 시스템');
  await page.fill('#todoInput', '역마진 방지 검증'); await page.press('#todoInput', 'Enter');
  await page.fill('#todoInput', '두번째 할 일'); await page.click('#todoAdd');
  await page.fill('#todoInput', '   '); await page.click('#todoAdd');
  const todoCount = await page.$$eval('.todo', e=>e.length);
  if (todoCount !== 2) note('BUG', '할 일 추가 결과 ' + todoCount + '개 (2개 기대)');
  await page.click('.todo input >> nth=0'); await wait(100);
  await shot('09-board');
  await page.click('#saveBoard'); await wait(300);
  S = await state(); let P = S.projects.find(p=>p.id===S.current);
  if (P.prog !== 100) note('BUG', '진행률 250 입력 시 100으로 클램프 안 됨: ' + P.prog); else ok('진행률 250 → 100 클램프');
  if (!P.todos[0].done) note('BUG', '할 일 체크가 저장되지 않음');
  const stripTxt = await page.textContent('#strip');
  ok('strip: ' + stripTxt);
  await page.click('#btnBoard'); await wait(200);
  await page.fill('#p_prog', '-5'); await page.click('#saveBoard'); await wait(200);
  S = await state(); P = S.projects.find(p=>p.id===S.current);
  if (P.prog !== 0) note('BUG', '진행률 -5 → 0 클램프 안 됨'); else ok('진행률 -5 → 0 클램프');
  await page.click('#btnBoard'); await wait(200);
  await page.fill('#p_prog', '33.333'); await page.click('#saveBoard'); await wait(200);
  S = await state(); P = S.projects.find(p=>p.id===S.current);
  console.log('  진행률 33.333 저장값:', P.prog, '/ strip:', await page.textContent('#strip'));
  if (P.prog !== 33) note('WARN', '진행률 소수점 입력이 그대로 저장/표시됨 (' + P.prog + ')');
  await page.click('#btnBoard'); await wait(200);
  await page.fill('#p_prog', ''); await page.click('#saveBoard'); await wait(200);
  S = await state(); P = S.projects.find(p=>p.id===S.current);
  if (!Number.isFinite(P.prog)) note('BUG', '진행률 빈 입력 시 NaN 저장');
  await page.click('#btnBoard'); await wait(200);
  await page.fill('#p_prog', '40'); await page.click('#saveBoard'); await wait(200);
  // 컨텍스트에 보드 내용 들어가는지
  apiLog.length = 0;
  await page.fill('#input', '컨텍스트 확인'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .copy:not([hidden])').length === 3, null, {timeout:5000}).catch(()=>{});
  const ctxPrompt = apiLog.find(a=>a.p==='openai').body.messages[1].content;
  console.log('  컨텍스트 프롬프트:\n' + ctxPrompt.split('\n').map(l=>'    | '+l).join('\n'));
  if (!/관 파이프 상사/.test(ctxPrompt) || !/40%/.test(ctxPrompt) || !/두번째 할 일/.test(ctxPrompt)) note('BUG', '보드 내용이 프롬프트 컨텍스트에 빠짐');
  if (ctxPrompt.indexOf('규칙·수식') < 0 || ctxPrompt.indexOf('판매가 ≥ 원가 + 수수료 5%') > ctxPrompt.indexOf('진행률')) note('BUG', '규칙·수식 필드가 컨텍스트에 없거나 상태 필드보다 뒤에 옴');
  else ok('규칙·수식이 컨텍스트 맨 앞');
  S = await state(); if (S.projects.find(p=>p.id===S.current).rules !== '판매가 ≥ 원가 + 수수료 5%') note('BUG', '규칙·수식 필드가 저장되지 않음');
  if (/역마진 방지 검증/.test(ctxPrompt)) note('BUG', '완료 처리한 할 일이 "남은 할 일"에 포함됨');

  // 13) 프로젝트 목록: 추가/전환/이름변경/삭제
  await page.evaluate(()=>closeSheets()); await wait(150); await page.click('#strip'); await wait(300);
  await page.click('#newProjAdd'); await wait(200); // 빈 이름
  await page.fill('#newProjName', '두번째 프로젝트'); await page.press('#newProjName', 'Enter'); await wait(300);
  S = await state();
  if (S.projects.length !== 2) note('BUG', '프로젝트 추가 후 개수 ' + S.projects.length);
  if (!(await page.$('#feed .empty'))) note('BUG', '새 프로젝트 전환 후 빈 화면이 아님');
  await shot('10-projects');
  await page.evaluate(()=>closeSheets()); await wait(150); await page.click('#strip'); await wait(200);
  await page.click('.proj .ren >> nth=1'); await wait(200);
  S = await state();
  if (S.projects[1].name !== '이름변경됨') note('BUG', '이름 변경 안 됨: ' + S.projects[1].name); else ok('이름 변경');
  if (!/이름변경됨/.test(await page.textContent('#strip'))) note('BUG', '이름 변경 후 상단 strip 미갱신');
  await page.click('.proj .nm >> nth=0'); await wait(300);
  S = await state();
  if (S.current !== S.projects[0].id) note('BUG', '프로젝트 전환 실패');
  if ((await page.$$eval('.turn', e=>e.length)) < 5) note('BUG', '전환 후 이전 프로젝트 대화가 복원되지 않음'); else ok('프로젝트 전환 + 대화 복원');
  await page.evaluate(()=>closeSheets()); await wait(150); await page.click('#strip'); await wait(200);
  await page.click('.proj .del >> nth=1'); await wait(300);
  S = await state();
  if (S.projects.length !== 1) note('BUG', '프로젝트 삭제 실패'); else ok('프로젝트 삭제');
  await page.evaluate(()=>closeSheets()); await wait(150); await page.click('#strip'); await wait(200);
  await page.click('.proj .del >> nth=0'); await wait(200);
  S = await state();
  if (S.projects.length !== 1) note('BUG', '마지막 프로젝트가 삭제됨'); else ok('마지막 프로젝트 삭제 차단');
  await page.click('.close >> nth=0'); await wait(200);

  // 14) 대화 중 프로젝트 전환 → 응답이 원래 프로젝트에 저장되는지
  await page.evaluate(()=>closeSheets()); await wait(150); await page.click('#strip'); await page.fill('#newProjName', 'B'); await page.press('#newProjName','Enter'); await wait(200); await page.evaluate(()=>closeSheets()); await wait(150);
  mode = 'ok';
  let release; const gate = new Promise(r=>release=r);
  await page.unroute(/api\.openai\.com/);
  await page.route(/api\.openai\.com/, async r => { await gate; r.fulfill({status:200, contentType:'application/json', body:JSON.stringify({choices:[{message:{content:'늦은 답변'}}]})}); });
  await page.fill('#input', 'B에서 질문'); await page.click('#send'); await wait(300);
  await page.evaluate(()=>closeSheets()); await wait(150); await page.click('#strip'); await page.click('.proj .nm >> nth=0'); await wait(300); // 첫 프로젝트로 전환
  release(); await wait(800);
  S = await state();
  const B = S.projects.find(p=>p.name==='B'); const A = S.projects[0];
  if (!B.log.some(e=>e.text==='늦은 답변')) note('BUG', '대화 중 프로젝트를 바꾸면 늦게 온 답변이 원래 프로젝트에 저장되지 않음');
  if (A.log.some(e=>e.text==='늦은 답변')) note('BUG', '늦게 온 답변이 엉뚱한 프로젝트에 저장됨');
  if (await page.$('#feed .card .body:has-text("늦은 답변")')) note('BUG', '늦게 온 답변 카드가 다른 프로젝트 화면에 남아 있음');
  ok('대화 중 프로젝트 전환 검사 완료');

  // 15) 대화 기록 지우기
  await page.click('#btnBoard'); await page.click('#clearLog'); await wait(300);
  S = await state();
  if (S.projects[0].log.length) note('BUG', '대화 기록 지우기 실패'); else ok('대화 기록 지우기');

  // 16) ESC 로 시트 닫기
  await page.click('#btnSettings'); await wait(200); await page.keyboard.press('Escape'); await wait(200);
  if (await page.$('#sheetSettings.on')) note('A11Y', 'Escape 키로 시트가 닫히지 않음');
  await page.click('#scrim', {position:{x:10,y:10}}).catch(()=>{}); await wait(200);

  // 17) 60개 로그 제한 + 잘린 로그 렌더
  await page.evaluate(() => { const s=JSON.parse(localStorage.getItem('aiteam.v1')); const p=s.projects[0]; p.log=[]; for(let i=0;i<20;i++){ p.log.push({role:'user',text:'q'+i}); p.log.push({role:'ai',agent:'openai',text:'a'+i}); p.log.push({role:'ai',agent:'anthropic',text:'b'+i}); p.log.push({role:'ai',agent:'google',text:'c'+i}); } localStorage.setItem('aiteam.v1', JSON.stringify(s)); });
  await page.reload(); await wait(300);
  await page.fill('#input', '61번째'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.turn:last-child .card .copy:not([hidden])').length === 3, null, {timeout:5000}).catch(()=>{});
  S = await state();
  console.log('  로그 개수(60 제한):', S.projects[0].log.length, '첫 항목 role:', S.projects[0].log[0].role);
  await page.reload(); await wait(300);
  if (errors.length) note('BUG', '페이지 오류: ' + errors.join(' || '));

  // 18) 손상된 저장 데이터 (todos: null)
  await page.evaluate(() => { const s=JSON.parse(localStorage.getItem('aiteam.v1')); s.projects[0].todos=null; s.projects[0].log=null; localStorage.setItem('aiteam.v1', JSON.stringify(s)); });
  errors.length = 0;
  await page.reload(); await wait(300);
  if (errors.length) note('BUG', '저장 데이터에 todos/log 가 null 이면 앱이 죽음: ' + errors[0]); else ok('null todos/log 복구');
  await page.evaluate(() => localStorage.removeItem('aiteam.v1'));

  // 19) 구버전(단일 프로젝트) 데이터 이전
  await page.evaluate(() => localStorage.setItem('aiteam.v1', JSON.stringify({keys:{openai:'sk-old',anthropic:'',google:''},models:{openai:'gpt-4o-mini'},roles:{},mode:'debate',project:{name:'옛 프로젝트',prog:55,stack:'Godot',now:'x',next:'y',todos:[{text:'t',done:false}]},log:[{role:'user',text:'옛 질문'},{role:'ai',agent:'openai',text:'옛 답'}]})));
  errors.length = 0;
  await page.reload(); await wait(300);
  S = await state();
  if (S.projects.length!==1 || S.projects[0].name!=='옛 프로젝트' || S.projects[0].prog!==55 || S.projects[0].log.length!==2) note('BUG', '구버전 데이터 이전 실패: ' + JSON.stringify(S.projects[0]).slice(0,200)); else ok('구버전 데이터 이전');
  if (!(await page.$('.mode[data-mode="debate"].on'))) note('BUG', '저장된 모드(debate)가 시작 시 반영 안 됨');
  await shot('11-migrated');

  // 20) 데스크톱 뷰
  await page.setViewportSize({width:1280,height:800}); await wait(200); await shot('12-desktop');

  if (errors.length) note('BUG', '페이지 오류: ' + errors.join(' || '));
  console.log('\n==== 요약 ====');
  findings.forEach(f=>console.log(`[${f.sev}] ${f.msg}`));
  console.log('총', findings.length, '건');
  await browser.close(); server.close();
})().catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
