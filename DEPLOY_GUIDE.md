# 배포 가이드 — 주문 관리 시스템 v2

## 필요한 계정 (모두 무료)
- Supabase: https://supabase.com  (DB + 인증)
- Railway:  https://railway.app   (FastAPI 백엔드, 월 ~$5)
- Vercel:   https://vercel.com    (Next.js 프론트엔드, 무료)
- GitHub:   https://github.com    (코드 저장소)

---

## STEP 1 — Supabase 프로젝트 생성

1. supabase.com 회원가입 → 새 프로젝트 생성
2. 프로젝트 이름: `order-management` / DB 비밀번호 메모
3. 프로젝트 생성 후 Settings → API 에서 아래 3가지 복사:
   - Project URL      → `SUPABASE_URL`
   - anon public key  → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - service_role key → `SUPABASE_SERVICE_KEY`  ⚠️ 절대 공개 금지

4. SQL Editor 에서 아래 순서대로 실행:
   - database/01_schema.sql
   - database/02_functions.sql
   - database/03_rls.sql

5. Authentication → Users → Invite user 로 팀원 계정 생성
   (또는 직접 이메일 초대)

---

## STEP 2 — GitHub 저장소 생성

1. GitHub에서 새 저장소(private) 생성
2. order_system 폴더 전체를 push:
   ```
   cd order_system
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/YOUR_USER/order-management.git
   git push -u origin main
   ```

---

## STEP 3 — Railway로 FastAPI 백엔드 배포

1. railway.app 회원가입 → GitHub 연동
2. New Project → Deploy from GitHub repo → backend 폴더 선택
3. Variables 탭에서 환경변수 추가:
   ```
   SUPABASE_URL       = (STEP 1에서 복사한 값)
   SUPABASE_SERVICE_KEY = (STEP 1에서 복사한 값)
   FRONTEND_URL       = https://YOUR_APP.vercel.app  (STEP 4 완료 후 수정)
   ```
4. Deploy 클릭 → 완료 후 도메인 메모 (예: https://order-api.up.railway.app)

---

## STEP 4 — Vercel로 Next.js 프론트엔드 배포

1. vercel.com 회원가입 → GitHub 연동
2. New Project → Import → order-management 저장소 → frontend 폴더 선택
3. Environment Variables 추가:
   ```
   NEXT_PUBLIC_SUPABASE_URL      = (STEP 1에서 복사한 값)
   NEXT_PUBLIC_SUPABASE_ANON_KEY = (STEP 1에서 복사한 값)
   NEXT_PUBLIC_API_URL           = (STEP 3에서 복사한 Railway 도메인)
   ```
4. Deploy 클릭

5. 배포 완료 후 Vercel 도메인을 Railway의 FRONTEND_URL 변수에 업데이트

---

## STEP 5 — 첫 접속 확인

1. Vercel 도메인으로 접속
2. Supabase에서 만든 계정으로 로그인
3. 엑셀 파일 업로드 테스트

---

## 팀원 추가하는 방법

Supabase → Authentication → Users → Invite user  
이메일만 입력하면 초대 메일이 발송됩니다.

---

## 문제 해결

| 증상 | 확인 사항 |
|------|-----------|
| 로그인이 안 됨 | Supabase Auth에 계정이 생성됐는지 확인 |
| 업로드 후 데이터가 안 보임 | Railway 백엔드 로그 확인, SUPABASE_SERVICE_KEY 확인 |
| 상태 변경이 안 됨 | RLS 정책이 03_rls.sql 실행됐는지 확인 |
| 엑셀 다운로드 실패 | NEXT_PUBLIC_API_URL이 Railway 주소와 일치하는지 확인 |
