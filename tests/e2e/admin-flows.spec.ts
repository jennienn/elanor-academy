import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { hasTestEnvironmentFile, loadAndValidateTestEnvironment } from "../support/test-env";
import { addCalendarDays, koreaDateString } from "../../src/lib/business-rules";

const env = hasTestEnvironmentFile() ? loadAndValidateTestEnvironment({ requireServiceRole: true }) : null;
const suffix = `${Date.now()}_${randomBytes(2).toString("hex")}`;
const memberName = `테스트회원_E2E_${suffix}`;
const groupMemberName = `테스트회원_E2E_GROUP_${suffix}`;
const packageMemberName = `테스트회원_E2E_PACKAGE_${suffix}`;
const className = `테스트회원_E2E_CLASS_${suffix}`;
const createdMemberIds: number[] = [];
const bookingDate = addCalendarDays(koreaDateString(), 14);
const attendanceDate = (() => {
  const today = koreaDateString();
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = addCalendarDays(today, offset);
    if (new Date(`${candidate}T12:00:00+09:00`).getDay() === 1) return candidate;
  }
  throw new Error("출석 테스트 날짜를 계산하지 못했습니다.");
})();
let classId: number | null = null;
let productId: number | null = null;
let mondayScheduleId: number | null = null;
let groupMemberId: number | null = null;

test.skip(!env, ".env.test.local의 전용 테스트 DB와 E2E 계정이 필요합니다.");
test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("이메일").fill(env!.adminEmail!);
  await page.getByPlaceholder("비밀번호").fill(env!.adminPassword!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

function remainingCount(page: Page, count: number) {
  return page.getByText("남은 회차").locator("..").getByText(`${count}회`, { exact: true });
}

test.beforeAll(async () => {
  if (!env) return;
  if (!env.adminEmail || !env.adminPassword) throw new Error("TEST_ADMIN_EMAIL과 TEST_ADMIN_PASSWORD가 필요합니다.");
  const admin = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
  const { data: cls, error } = await admin
    .from("classes")
    .insert({ name: className, capacity: 10, active: true })
    .select("id")
    .single();
  if (error || !cls) throw error ?? new Error("E2E class 생성 실패");
  classId = cls.id;
  const schedules = await admin
    .from("class_schedules")
    .insert([
      { class_id: classId, weekday: 1, curriculum_group: "A" },
      { class_id: classId, weekday: 3, curriculum_group: "B" }
    ])
    .select("id, weekday");
  if (schedules.error) throw schedules.error;
  const product = await admin.from("lesson_products").insert({ kind: "group", name: className, class_id: classId, session_count: 8, valid_weeks: 5, price: 160000, duration_minutes: 60 }).select("id").single();
  if (product.error) throw product.error;
  productId = product.data.id;
  mondayScheduleId = schedules.data!.find((schedule) => schedule.weekday === 1)!.id;
});

test.afterAll(async () => {
  if (!env) return;
  const admin = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
  for (const id of createdMemberIds.reverse()) await admin.from("members").delete().eq("id", id);
  if (productId !== null) await admin.from("lesson_products").delete().eq("id", productId);
  if (classId !== null) await admin.from("classes").delete().eq("id", classId);
});

test("로그인, 회원 목록, 개인레슨 등록, 첫 수업, 잔여 회차, 재등록", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "회원", exact: true }).click();
  await expect(page.getByRole("heading", { name: "회원" })).toBeVisible();
  await page.getByRole("button", { name: "+ 회원 등록" }).click();
  await page.getByPlaceholder("홍길동").fill(memberName);
  await page.getByPlaceholder("010-0000-0000").fill("01090000001");
  await page.getByRole("button", { name: "4회권" }).click();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/products/purchase") && response.request().method() === "POST");
  await page.getByRole("button", { name: "등록 완료", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  createdMemberIds.push((await response.json()).memberId);

  await expect(page.getByRole("heading", { name: memberName })).toBeVisible();
  await expect(remainingCount(page, 4)).toBeVisible();
  await page.getByRole("button", { name: "+ 수업 기록 추가" }).click();
  await page.getByRole("button", { name: "기록 추가", exact: true }).click();
  await expect(remainingCount(page, 3)).toBeVisible();

  await page.getByRole("button", { name: "결제 확인", exact: true }).click();
  await page.getByRole("button", { name: "4회권" }).click();
  await page.getByRole("button", { name: "결제 확인 완료" }).click();
  await expect(remainingCount(page, 7)).toBeVisible();
});

test("수강생이 예약하고 운영자가 오늘 수업에서 기존 회차로 완료 처리한다", async ({ page }) => {
  await page.goto("/booking");
  await page.getByLabel("이름").fill(memberName);
  await page.getByLabel("전화번호").fill("010-9000-0001");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${memberName}님` })).toBeVisible();
  await expect(page.getByText(/개인 4회권 이용 중 · 60분/)).toBeVisible();

  if (bookingDate.slice(0, 7) !== koreaDateString().slice(0, 7)) await page.getByRole("button", { name: "다음 달", exact: true }).click();
  const bookingDateButton = page.getByRole("button", { name: bookingDate, exact: true });
  await expect(bookingDateButton).toBeEnabled();
  await bookingDateButton.click();
  await expect(bookingDateButton).toHaveAttribute("aria-pressed", "true");
  const bookingTimeButton = page.locator(".reservation-times button:enabled").first();
  await expect(bookingTimeButton).toBeVisible();
  const bookingTime = (await bookingTimeButton.textContent())!.trim();
  await bookingTimeButton.click();
  const reserveResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/booking") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "예약 완료", exact: true }).click();
  const reservationResponse = await reserveResponse;
  expect(reservationResponse.status(), await reservationResponse.text()).toBe(201);
  const [hour, minute] = bookingTime.split(":").map(Number);
  const endTime = `${String(hour + 1).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  await expect(page.getByText(`${bookingTime} ~ ${endTime} · 수업 전`, { exact: true })).toBeVisible();

  await login(page);
  await page.getByRole("link", { name: "수업 일정" }).click();
  if (bookingDate.slice(0, 7) !== koreaDateString().slice(0, 7)) await page.getByRole("button", { name: "다음 달", exact: true }).click();
  const previousDate = addCalendarDays(bookingDate, -1);
  await page.getByRole("button", { name: new RegExp(`^${previousDate}`) }).click();
  await expect(page.getByText(memberName, { exact: true })).toBeHidden();
  await page.getByRole("button", { name: new RegExp(`^${bookingDate}`) }).click();
  const reservationRow = page.getByText(memberName, { exact: true }).locator("../..");
  const completeButton = reservationRow.getByRole("button", { name: "수업 완료 처리" });
  await expect(completeButton).toBeEnabled();
  await completeButton.click();
  const completionDialog = page.getByRole("dialog", { name: "수업 완료 확인" });
  await expect(completionDialog).toContainText(`${bookingTime} · ${memberName}`);
  await completionDialog.getByRole("button", { name: "완료 처리", exact: true }).click();
  await expect(page.getByText(`${memberName}님의 수업을 완료 처리했습니다.`)).toBeVisible();
  await expect(reservationRow).toContainText("완료");

  await page.goto("/booking");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  expect((await page.request.get("/api/booking")).status()).toBe(401);
});

test("단체 회원 복수 요일 등록, 출석 등록과 취소", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "회원", exact: true }).click();
  await page.getByRole("button", { name: "+ 회원 등록" }).click();
  const modal = page.getByRole("dialog", { name: "회원 등록" });
  await modal.getByPlaceholder("홍길동").fill(groupMemberName);
  await modal.getByPlaceholder("010-0000-0000").fill("01090000002");
  await modal.getByRole("button", { name: "단체레슨" }).click();
  await modal.getByRole("button", { name: className, exact: true }).click();
  await modal.getByRole("button", { name: "월", exact: true }).click();
  await modal.getByRole("button", { name: "수", exact: true }).click();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/products/purchase") && response.request().method() === "POST");
  await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  groupMemberId = (await response.json()).memberId;
  createdMemberIds.push(groupMemberId!);
  await expect(page.getByText(`단체 ${className}`)).toBeVisible();

  await page.getByRole("link", { name: "단체 출석" }).click();
  await page.getByRole("button", { name: className, exact: true }).click();
  await page.getByRole("button", { name: attendanceDate, exact: true }).click();
  const memberCheckbox = page.getByText(groupMemberName).locator("..").getByRole("checkbox");
  await memberCheckbox.check();
  await page.getByRole("button", { name: /선택한 1명 출석 처리/ }).click();
  await expect(page.getByText("1명의 출석이 저장되었습니다.")).toBeVisible();
  await page.goto(`/members/${groupMemberId}`);
  await expect(page.getByText("최근 출석 기록")).toBeVisible();
  await expect(page.getByText(`출석 · ${attendanceDate}`)).toBeVisible();
  await page.getByRole("link", { name: "단체 출석" }).click();
  await page.getByRole("button", { name: className, exact: true }).click();
  await page.getByRole("button", { name: attendanceDate, exact: true }).click();
  await page.getByText(groupMemberName).locator("..").getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: /선택한 0명 출석 처리/ }).click();
  await expect(page.getByText("0명의 출석이 저장되었습니다.")).toBeVisible();
});

test("신규 회원 등록에서 스타터 패키지를 바로 등록한다", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "회원", exact: true }).click();
  await page.getByRole("button", { name: "+ 회원 등록" }).click();
  const modal = page.getByRole("dialog", { name: "회원 등록" });
  await modal.getByPlaceholder("홍길동").fill(packageMemberName);
  await modal.getByPlaceholder("010-0000-0000").fill("01090000003");
  await modal.getByRole("button", { name: "패키지", exact: true }).click();
  await modal.getByRole("button", { name: "스타터 패키지", exact: true }).click();
  await expect(modal.getByText(/개인 2회 \+ 단체 4회/)).toBeVisible();
  await modal.getByLabel("단체반").selectOption(String(productId));
  await modal.getByRole("button", { name: "월", exact: true }).click();
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/products/purchase") && response.request().method() === "POST"
  );
  await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  createdMemberIds.push((await response.json()).memberId);

  await expect(page.getByRole("heading", { name: packageMemberName })).toBeVisible();
  await expect(remainingCount(page, 2)).toBeVisible();
  await expect(page.getByText(`단체 스타터 패키지 · ${className}`)).toBeVisible();
});

test("반의 capacity 값을 넘어도 회원을 등록한다", async ({ page }) => {
  await login(page);
  for (let index = 0; index < 8; index += 1) {
    const response = await page.request.post("/api/members", {
      data: {
        name: `테스트회원_E2E_CAPACITY_${suffix}_${index + 1}`,
        phone: `010-9001-${String(index + 1).padStart(4, "0")}`,
        enrollment: {
          kind: "group",
          className,
          scheduleIds: [mondayScheduleId],
          payment: { amount: 160000, method: "card", paymentDate: "2026-07-14" }
        }
      }
    });
    expect(response.status()).toBe(201);
    createdMemberIds.push((await response.json()).memberId);
  }

  await page.getByRole("link", { name: "회원", exact: true }).click();
  await page.getByRole("button", { name: "+ 회원 등록" }).click();
  const modal = page.getByRole("dialog", { name: "회원 등록" });
  const overCapacityMemberName = `테스트회원_E2E_CAPACITY_UNLIMITED_${suffix}`;
  await modal.getByPlaceholder("홍길동").fill(overCapacityMemberName);
  await modal.getByPlaceholder("010-0000-0000").fill("01090019999");
  await modal.getByRole("button", { name: "단체레슨" }).click();
  await modal.getByRole("button", { name: className, exact: true }).click();
  await modal.getByRole("button", { name: "월", exact: true }).click();
  const createResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/products/purchase") && response.request().method() === "POST"
  );
  await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  createdMemberIds.push((await response.json()).memberId);
  await expect(page.getByRole("heading", { name: overCapacityMemberName })).toBeVisible();
});

test("회원 등록 누락·잘못된 연락처·중복 연락처를 차단한다", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "회원", exact: true }).click();
  await page.getByRole("button", { name: "+ 회원 등록" }).click();
  const modal = page.getByRole("dialog", { name: "회원 등록" });

  await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
  await expect(modal.getByText("이름을 입력해주세요.")).toBeVisible();
  await modal.getByPlaceholder("홍길동").fill("테스트회원_입력검증");
  await modal.getByPlaceholder("010-0000-0000").fill("010123");
  await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
  await expect(modal.getByText(/010-0000-0000 형식/)).toBeVisible();

  await modal.getByPlaceholder("010-0000-0000").fill("01090000001");
  await modal.getByRole("button", { name: "4회권" }).click();
  const duplicateResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/products/purchase") && response.request().method() === "POST"
  );
  await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
  expect((await duplicateResponse).status()).toBe(409);
  await expect(modal.getByText(/이미 등록된 연락처/)).toBeVisible();
});

test("회원 삭제는 확인 후 연결 데이터를 함께 제거하고 목록으로 이동한다", async ({ page }) => {
  await login(page);
  const createResponse = await page.request.post("/api/members", {
    data: {
      name: `테스트회원_E2E_DELETE_${suffix}`,
      phone: "010-9002-0001",
      enrollment: {
        kind: "solo",
        plan: 4,
        payment: { amount: 200000, method: "card", paymentDate: "2026-08-01" }
      }
    }
  });
  expect(createResponse.status()).toBe(201);
  const memberId = (await createResponse.json()).memberId as number;
  createdMemberIds.push(memberId);

  await page.goto(`/members/${memberId}`);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("복구할 수 없습니다");
    await dialog.accept();
  });
  const deleteResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/api/members/${memberId}`) && response.request().method() === "DELETE"
  );
  await page.getByRole("button", { name: "회원 삭제" }).click();
  expect((await deleteResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/members$/);
  expect((await page.request.get(`/api/members/${memberId}`)).status()).toBe(404);
});

test("로그아웃 후 보호 페이지와 API 접근이 차단된다", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/members");
  await expect(page).toHaveURL(/\/login$/);
  const response = await page.request.get("/api/members", { maxRedirects: 0 });
  expect(response.status()).toBe(401);
  expect((await page.request.get("/api/products")).status()).toBe(401);
  expect((await page.request.post("/api/products", { data: {} })).status()).toBe(401);
  expect((await page.request.post("/api/products/purchase", { data: {} })).status()).toBe(401);
});

test("모바일·태블릿 반응형, 모달 키보드, API 실패와 404 상태", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("link", { name: "회원", exact: true }).click();

  const sidebarBox = await page.locator(".sidebar").boundingBox();
  expect(sidebarBox?.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "+ 회원 등록" })).toBeVisible();
  await page.getByRole("button", { name: "+ 회원 등록" }).click();
  const dialog = page.getByRole("dialog", { name: "회원 등록" });
  await expect(dialog).toBeVisible();
  await expect(page.getByPlaceholder("홍길동")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "+ 회원 등록" })).toBeFocused();

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "회원" })).toBeVisible();

  await page.route("**/api/members**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "회원 목록을 불러오지 못했습니다." } })
    })
  );
  await page.reload();
  await expect(page.getByText("회원 목록을 불러오지 못했습니다.")).toBeVisible();
  await page.unroute("**/api/members**");

  await page.goto("/존재하지-않는-주소");
  await expect(page.getByRole("heading", { name: "페이지를 찾을 수 없습니다." })).toBeVisible();
});

test("비밀번호 재설정 입력 검증과 공개 접근", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "비밀번호 재설정" }).click();
  await expect(page.getByText("비밀번호를 재설정할 이메일을 입력해주세요.", { exact: true })).toBeVisible();
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "비밀번호 재설정" })).toBeVisible();
  await page.getByLabel("새 비밀번호", { exact: true }).fill("password-one");
  await page.getByLabel("새 비밀번호 확인").fill("password-two");
  await page.getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(page.getByText("비밀번호가 서로 일치하지 않습니다.", { exact: true })).toBeVisible();
});

test("수강권 생성·수정·판매 중단과 구매 조건 보존", async ({ page }, testInfo) => {
  await login(page);
  const productName = `테스트회원_상품_${suffix}`;
  const buyerName = `테스트회원_상품구매_${suffix}`;
  let customProductId: number | null = null;
  try {
    await page.getByRole("link", { name: "수강권 관리" }).click();
    await page.getByRole("button", { name: "수강권 추가", exact: true }).click();
    let modal = page.getByRole("dialog", { name: "수강권 추가" });
    await modal.getByLabel("수강권 이름").fill(productName);
    await modal.getByLabel("가격 (원)").fill("210000");
    await modal.getByLabel("수업 횟수", { exact: true }).fill("6");
    await modal.getByLabel("유효기간 (주)").fill("7");
    await modal.getByLabel("1회 수업 길이 (분)").fill("45");
    const saved = page.waitForResponse(r => r.url().endsWith("/api/products") && r.request().method() === "POST");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    const response = await saved; expect(response.status()).toBe(200);
    customProductId = (await response.json()).id;
    await expect(page.getByRole("heading", { name: productName })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("products.png"), fullPage: true });
    await page.getByRole("link", { name: "회원", exact: true }).click();
    await page.getByRole("button", { name: "+ 회원 등록" }).click();
    modal = page.getByRole("dialog", { name: "회원 등록" });
    await modal.getByLabel("이름", { exact: true }).fill(buyerName);
    await modal.getByLabel("연락처").fill("01090038888");
    await modal.getByRole("button", { name: productName, exact: true }).click();
    await expect(modal).toContainText("210,000원");
    const purchased = page.waitForResponse(r => r.url().endsWith("/api/products/purchase") && r.request().method() === "POST");
    await modal.getByRole("button", { name: "등록 완료", exact: true }).click();
    const purchase = await purchased; expect(purchase.status()).toBe(201);
    const { memberId } = await purchase.json(); createdMemberIds.push(memberId);
    await expect(remainingCount(page, 6)).toBeVisible();
    await expect(page.getByText("45분 · 7주")).toBeVisible();
    await page.getByRole("link", { name: "수강권 관리" }).click();
    await page.getByRole("button", { name: `${productName} 수정`, exact: true }).click();
    modal = page.getByRole("dialog", { name: "수강권 수정" });
    await modal.getByLabel("가격 (원)").fill("300000");
    await modal.getByLabel("수업 횟수", { exact: true }).fill("9");
    await modal.getByLabel("유효기간 (주)").fill("10");
    await modal.getByLabel("1회 수업 길이 (분)").fill("90");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    await expect(modal).toBeHidden();
    await page.goto(`/members/${memberId}`);
    await expect(remainingCount(page, 6)).toBeVisible();
    await expect(page.getByText("45분 · 7주")).toBeVisible();
    await page.getByRole("button", { name: "결제 확인", exact: true }).click();
    modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: productName, exact: true }).click();
    await expect(modal).toContainText("300,000원");
    await modal.getByRole("button", { name: "결제 확인 완료" }).click();
    await expect(remainingCount(page, 15)).toBeVisible();
    await expect(page.getByText("90분 · 10주")).toBeVisible();
    await page.getByRole("link", { name: "수강권 관리" }).click();
    await page.getByRole("button", { name: `${productName} 수정`, exact: true }).click();
    modal = page.getByRole("dialog", { name: "수강권 수정" });
    await modal.getByLabel("판매 상태").selectOption("false");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    await expect(modal).toBeHidden();
    await page.goto(`/members/${memberId}`);
    await expect(remainingCount(page, 15)).toBeVisible();
    await page.getByRole("button", { name: "결제 확인", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: productName, exact: true })).toHaveCount(0);
    const offered = await page.request.get("/api/products");
    expect((await offered.json()).products.some((p: { id: number }) => p.id === customProductId)).toBe(false);
  } finally {
    const admin = createClient(env!.url, env!.serviceRoleKey);
    // Remove only this test's purchases before deleting their referenced product.
    const members = await admin.from("members").select("id").eq("name", buyerName);
    for (const member of members.data ?? []) await admin.from("members").delete().eq("id", member.id);
    if (customProductId) await admin.from("lesson_products").delete().eq("id", customProductId);
  }
});

test("미판매 수강권은 삭제하고 판매 중단 수강권은 별도 목록에 표시한다", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "수강권 관리" }).click();
  const name = `테스트회원_삭제_${suffix}`;
  let productId: number | null = null;
  const admin = createClient(env!.url, env!.serviceRoleKey);
  try {
    await page.getByRole("button", { name: "수강권 추가" }).click();
    let modal = page.getByRole("dialog", { name: "수강권 추가" });
    await modal.getByLabel("수강권 이름").fill(name);
    await modal.getByLabel("판매 상태").selectOption("false");
    const saved = page.waitForResponse(r => r.url().endsWith("/api/products") && r.request().method() === "POST");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    productId = (await (await saved).json()).id;
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await page.getByRole("button", { name: /판매 중 \d+/, exact: true }).click();
    await expect(page.getByRole("heading", { name })).toHaveCount(0);
    await page.getByRole("button", { name: /판매 중단 \d+/, exact: true }).click();
    await page.getByRole("button", { name: `${name} 수정` }).click();
    modal = page.getByRole("dialog", { name: "수강권 수정" });
    await expect(modal.getByRole("button", { name: "삭제" })).toBeVisible();
    page.once("dialog", dialog => void dialog.accept());
    await modal.getByRole("button", { name: "삭제" }).click();
    await expect(page.getByRole("heading", { name })).toHaveCount(0);
    expect((await admin.from("lesson_products").select("id").eq("id", productId)).data).toEqual([]);
  } finally {
    if (productId) await admin.from("lesson_products").delete().eq("id", productId);
  }
});

test("단체반 요일·시작시간과 판매 상태를 관리한다", async ({ page }) => {
  await login(page);
  const name = `테스트회원_시간표_${suffix}`;
  const admin = createClient(env!.url, env!.serviceRoleKey);
  try {
    await page.getByRole("link", { name: "수강권 관리" }).click();
    await page.getByRole("button", { name: "수강권 추가", exact: true }).click();
    let modal = page.getByRole("dialog", { name: "수강권 추가" });
    await modal.getByLabel("수강 종류").selectOption("group");
    await modal.getByLabel("수강권 이름").fill(name);
    await modal.getByLabel("가격 (원)").fill("120000");
    await modal.getByLabel("월", { exact: true }).check();
    await modal.getByLabel("월 시작시간").fill("07:00");
    await modal.getByLabel("1회 수업 길이 (분)").fill("45");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    await expect(modal).toBeHidden();
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card).toContainText("월 07:00");
    await expect(card).toContainText("1회 수업 45분");
    await card.getByRole("button", { name: `${name} 수정`, exact: true }).click();
    modal = page.getByRole("dialog", { name: "수강권 수정" });
    await modal.getByLabel("월", { exact: true }).uncheck();
    await modal.getByLabel("화", { exact: true }).check();
    await modal.getByLabel("화 시작시간").fill("08:00");
    await modal.getByLabel("판매 상태").selectOption("false");
    await modal.getByRole("button", { name: "저장", exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(card).toContainText("화 08:00");
    await expect(card.getByText("판매 중단", { exact: true })).toBeVisible();
    const product = await admin.from("lesson_products").select("class_id").eq("name", name).single();
    const schedules = await admin.from("class_schedules").select("weekday,start_time,active").eq("class_id", product.data!.class_id);
    expect(schedules.data).toEqual(expect.arrayContaining([
      { weekday: 1, start_time: "07:00:00", active: false }, { weekday: 2, start_time: "08:00:00", active: true }
    ]));
  } finally {
    const products = await admin.from("lesson_products").select("id,class_id").eq("name", name);
    for (const product of products.data ?? []) {
      expect((await admin.from("lesson_products").delete().eq("id", product.id)).error).toBeNull();
      expect((await admin.from("classes").delete().eq("id", product.class_id)).error).toBeNull();
    }
  }
});
