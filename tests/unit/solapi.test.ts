import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSolapiAuthorization, normalizeKoreanPhone, sendSolapiAlimtalk } from "@/lib/solapi";

const ENV_KEYS = [
  "SOLAPI_API_KEY",
  "SOLAPI_API_SECRET",
  "KAKAO_CHANNEL_ID",
  "KAKAO_SENDER_PHONE",
  "TEST_MODE",
  "ALLOW_TEST_SOLAPI_SEND"
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("SOLAPI 알림톡 클라이언트", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T10:00:00+09:00"));
    process.env.SOLAPI_API_KEY = "test-api-key";
    process.env.SOLAPI_API_SECRET = "test-api-secret";
    process.env.KAKAO_CHANNEL_ID = "test-pf-id";
    process.env.KAKAO_SENDER_PHONE = "010-0000-0000";
    delete process.env.TEST_MODE;
    delete process.env.ALLOW_TEST_SOLAPI_SEND;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("한국 휴대전화 번호에서 구분 문자를 제거하고 잘못된 번호는 거부한다", () => {
    expect(normalizeKoreanPhone("010-1234-5678")).toBe("01012345678");
    expect(normalizeKoreanPhone("02-123-4567")).toBeNull();
    expect(normalizeKoreanPhone("000-DEMO-001")).toBeNull();
  });

  it("공식 규격대로 date+salt를 HMAC-SHA256 서명한다", () => {
    const dateTime = "2026-07-24T00:00:00.000Z";
    const salt = "1234567890123456";
    const signature = createHmac("sha256", "secret").update(`${dateTime}${salt}`).digest("hex");
    expect(createSolapiAuthorization("key", "secret", { dateTime, salt })).toBe(
      `HMAC-SHA256 apiKey=key, date=${dateTime}, salt=${salt}, signature=${signature}`
    );
  });

  it("필수 서버 환경변수가 없으면 외부 요청 없이 실패한다", async () => {
    delete process.env.SOLAPI_API_SECRET;
    const fetcher = vi.fn();
    const result = await sendSolapiAlimtalk(
      { to: "01012345678", text: "테스트", templateId: "template", variables: {} },
      { fetcher }
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "SOLAPI_NOT_CONFIGURED" })
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("테스트 모드에서는 키가 있어도 실제 외부 발송을 차단한다", async () => {
    process.env.TEST_MODE = "true";
    const fetcher = vi.fn();
    const result = await sendSolapiAlimtalk(
      { to: "01012345678", text: "테스트", templateId: "template", variables: {} },
      { fetcher }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "SOLAPI_DISABLED_IN_TEST" }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "2026-10-02T11:30:00+09:00"])("알림톡 즉시/예약 요청을 접수한다 (%s)", async (scheduledDate) => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        scheduledDate?: string;
        messages: Array<{
          to: string;
          from: string;
          type: string;
          kakaoOptions: { pfId: string; templateId: string; disableSms: boolean };
        }>;
      };
      if (scheduledDate) expect(body.scheduledDate).toBe(scheduledDate);
      else expect(body).not.toHaveProperty("scheduledDate");
      expect(init?.headers).toEqual(
        expect.objectContaining({ Authorization: expect.stringMatching(/^HMAC-SHA256 apiKey=test-api-key/) })
      );
      expect(body.messages[0]).toEqual(
        expect.objectContaining({
          to: "01012345678",
          from: "01000000000",
          type: "ATA",
          kakaoOptions: expect.objectContaining({
            pfId: "test-pf-id",
            templateId: "test-template",
            disableSms: true
          })
        })
      );
      return new Response(
        JSON.stringify({
          groupInfo: { groupId: "group-1" },
          messageList: [{ messageId: "message-1", statusCode: "2000", statusMessage: "정상 접수" }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    await expect(
      sendSolapiAlimtalk(
        {
          to: "010-1234-5678",
          text: "테스트",
          templateId: "test-template",
          variables: { "#{회원명}": "테스트회원" },
          scheduledDate
        },
        { fetcher }
      )
    ).resolves.toEqual({ ok: true, groupId: "group-1", messageId: "message-1" });
  });

  it.each(["invalid", "", "2026-10-02T09:00:00+09:00", "2026-10-02T10:10:00+09:00"])(
    "잘못되거나 임박한 예약을 즉시 발송하지 않는다 (%s)", async (scheduledDate) => {
      const fetcher = vi.fn();
      const result = await sendSolapiAlimtalk(
        { to: "01000000001", text: "테스트", templateId: "template", variables: {}, scheduledDate },
        { fetcher }
      );
      expect(result).toMatchObject({ ok: false, code: "INVALID_SCHEDULED_DATE" });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it("SOLAPI가 등록 실패 목록을 반환하면 성공으로 기록하지 않는다", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          failedMessageList: [{ statusCode: "3040", statusMessage: "등록되지 않은 발신번호입니다." }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await sendSolapiAlimtalk(
      { to: "01012345678", text: "테스트", templateId: "template", variables: {} },
      { fetcher }
    );
    expect(result).toEqual({
      ok: false,
      code: "3040",
      message: "등록되지 않은 발신번호입니다."
    });
  });
});
