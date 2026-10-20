import "server-only";
import { createHmac, randomBytes } from "node:crypto";

const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/detail";

export interface SolapiAlimtalkInput {
  to: string;
  text: string;
  templateId: string;
  variables: Record<string, string>;
  scheduledDate?: string;
}

export type SolapiSendResult =
  | { ok: true; groupId: string | null; messageId: string | null }
  | { ok: false; code: string; message: string };

interface SolapiConfig {
  apiKey: string;
  apiSecret: string;
  pfId: string;
  senderPhone: string;
}

interface SolapiResponse {
  groupInfo?: { groupId?: string };
  messageList?: Array<{ messageId?: string; statusCode?: string; statusMessage?: string }>;
  failedMessageList?: Array<{ messageId?: string; statusCode?: string; statusMessage?: string }>;
  errorCode?: string;
  errorMessage?: string;
  message?: string;
}

export function normalizeKoreanPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (!/^01\d{8,9}$/.test(digits)) return null;
  return digits;
}

export function createSolapiAuthorization(
  apiKey: string,
  apiSecret: string,
  options: { dateTime?: string; salt?: string } = {}
): string {
  const dateTime = options.dateTime ?? new Date().toISOString();
  const salt = options.salt ?? randomBytes(16).toString("hex");
  const signature = createHmac("sha256", apiSecret).update(`${dateTime}${salt}`).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${dateTime}, salt=${salt}, signature=${signature}`;
}

function loadSolapiConfig(): SolapiConfig | SolapiSendResult {
  if (process.env.TEST_MODE === "true" && process.env.ALLOW_TEST_SOLAPI_SEND !== "true") {
    return {
      ok: false,
      code: "SOLAPI_DISABLED_IN_TEST",
      message: "테스트 환경에서는 실제 알림톡 발송을 차단합니다."
    };
  }
  const apiKey = process.env.SOLAPI_API_KEY?.trim();
  const apiSecret = process.env.SOLAPI_API_SECRET?.trim();
  const pfId = process.env.KAKAO_CHANNEL_ID?.trim();
  const senderPhone = process.env.KAKAO_SENDER_PHONE?.trim();
  if (!apiKey || !apiSecret || !pfId || !senderPhone) {
    return {
      ok: false,
      code: "SOLAPI_NOT_CONFIGURED",
      message: "SOLAPI_API_KEY, SOLAPI_API_SECRET, KAKAO_CHANNEL_ID, KAKAO_SENDER_PHONE 설정이 필요합니다."
    };
  }
  return { apiKey, apiSecret, pfId, senderPhone };
}

export async function sendSolapiAlimtalk(
  input: SolapiAlimtalkInput,
  options: { fetcher?: typeof fetch } = {}
): Promise<SolapiSendResult> {
  const config = loadSolapiConfig();
  if ("ok" in config) return config;

  const to = normalizeKoreanPhone(input.to);
  const from = normalizeKoreanPhone(config.senderPhone);
  if (!to || !from) {
    return { ok: false, code: "INVALID_PHONE", message: "수신번호 또는 발신번호 형식이 올바르지 않습니다." };
  }
  if (!input.templateId) {
    return { ok: false, code: "TEMPLATE_NOT_CONFIGURED", message: "알림톡 템플릿 ID가 설정되지 않았습니다." };
  }

  // SOLAPI는 과거 예약 시간을 즉시 발송으로 처리하므로 전송 직전에 차단한다.
  if (input.scheduledDate !== undefined &&
      !(Date.parse(input.scheduledDate) - Date.now() > 10 * 60 * 1000)) {
    return { ok: false, code: "INVALID_SCHEDULED_DATE", message: "예약 발송은 현재보다 10분 이후여야 합니다." };
  }

  try {
    const response = await (options.fetcher ?? fetch)(SOLAPI_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: createSolapiAuthorization(config.apiKey, config.apiSecret),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          {
            to,
            from,
            text: input.text,
            type: "ATA",
            kakaoOptions: {
              pfId: config.pfId,
              templateId: input.templateId,
              disableSms: true,
              variables: input.variables
            }
          }
        ],
        scheduledDate: input.scheduledDate,
        strict: true,
        allowDuplicates: false,
        showMessageList: true
      })
    });
    const body = (await response.json().catch(() => ({}))) as SolapiResponse;
    const failed = body.failedMessageList?.[0];
    if (!response.ok || failed || body.errorCode) {
      return {
        ok: false,
        code: failed?.statusCode ?? body.errorCode ?? `HTTP_${response.status}`,
        message: failed?.statusMessage ?? body.errorMessage ?? body.message ?? "SOLAPI 발송 요청에 실패했습니다."
      };
    }
    const accepted = body.messageList?.[0];
    if (!accepted?.messageId) {
      return { ok: false, code: "INVALID_SOLAPI_RESPONSE", message: "SOLAPI 접수 응답에 messageId가 없습니다." };
    }
    return {
      ok: true,
      groupId: body.groupInfo?.groupId ?? null,
      messageId: accepted.messageId
    };
  } catch (error) {
    return {
      ok: false,
      code: "SOLAPI_NETWORK_ERROR",
      message: error instanceof Error ? error.message : "SOLAPI 네트워크 요청에 실패했습니다."
    };
  }
}
