import { createHmac, randomBytes } from "node:crypto";

const API_BASE = "https://api.solapi.com";
const apiKey = process.env.SOLAPI_API_KEY?.trim();
const apiSecret = process.env.SOLAPI_API_SECRET?.trim();
const updateExisting = process.argv.includes("--update-existing");

if (!apiKey || !apiSecret) {
  throw new Error("SOLAPI_API_KEY와 SOLAPI_API_SECRET이 필요합니다.");
}

function authorization() {
  const date = new Date().toISOString();
  const salt = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", apiSecret).update(`${date}${salt}`).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function request(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authorization(),
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path}: ${body.errorMessage ?? body.message ?? body.errorCode ?? response.status}`);
  }
  return body;
}

const channelResponse = await request("/kakao/v2/channels?isMine=true&limit=100");
const channels = channelResponse.channelList ?? [];
if (channels.length !== 1) {
  throw new Error(`본인 소유 카카오 채널이 1개여야 합니다. 현재 ${channels.length}개입니다.`);
}
const channel = channels[0];

const senders = await request("/senderid/v1/numbers/active");
if (!Array.isArray(senders) || senders.length !== 1) {
  throw new Error(`활성 발신번호가 1개여야 합니다. 현재 ${Array.isArray(senders) ? senders.length : 0}개입니다.`);
}
const senderPhone = typeof senders[0] === "string" ? senders[0] : senders[0]?.phoneNumber;
if (!senderPhone) {
  throw new Error("활성 발신번호 응답에서 전화번호를 찾을 수 없습니다.");
}

const definitions = [
  {
    env: "KAKAO_COMPLETED_SOLO_TEMPLATE_ID",
    name: "엘라노르_개인레슨_등록완료",
    content: `[엘라노르 댄스학원] 개인레슨 등록 완료 안내

안녕하세요, #{회원명}님!
엘라노르 댄스학원입니다. ✨

회원님의 개인레슨 수강 등록 및 결제가 정상적으로 완료되었습니다.

• 수강 과목: 개인레슨
• 등록 횟수: 총 #{등록횟수}회
• 수강 유효기간: 첫 수업일로부터 #{유효주수}주 이내

📌 개인레슨 수강권은 첫 수업 시작일을 기준으로 #{유효주수}주 이내에 사용해 주시면 됩니다.

회원님께 맞춘 알찬 레슨으로 정성껏 준비하겠습니다. 첫 레슨 날 뵙겠습니다! 💛`
  },
  {
    env: "KAKAO_COMPLETED_GROUP_TEMPLATE_ID",
    name: "엘라노르_단체레슨_등록완료",
    content: `[엘라노르 댄스학원] 단체레슨 등록 완료 안내

안녕하세요, #{회원명}님!
엘라노르 댄스학원입니다. ✨

요청하신 클래스의 수강 등록 및 결제가 정상적으로 완료되었습니다.

• 수강 클래스: #{수업명}
• 수강 기간: #{수강시작일} ~ #{수강종료일}

이번 수강 기간도 알차고 즐겁게 함께해요! 수업 날 뵙겠습니다. 💛`
  },
  {
    env: "KAKAO_DUE_SOLO_TEMPLATE_ID",
    name: "엘라노르_개인레슨_잔여안내",
    content: `[엘라노르 댄스학원] 개인레슨 잔여 횟수 안내

안녕하세요, #{회원명}님!
엘라노르 댄스학원입니다. ✨

회원님의 개인레슨 수강권 잔여 횟수를 안내해 드립니다.

• 수강 과목: 개인레슨
• 현재 잔여 횟수: #{잔여횟수}회 / #{총횟수}회
• 만료 예정일: #{만료예정일}

원활한 레슨 일정을 위해, 잔여 횟수가 소진되기 전 미리 재등록을 부탁드립니다.

궁금하신 점은 언제든 편하게 문의해 주세요! 오늘도 좋은 하루 보내세요. 💛`
  },
  {
    env: "KAKAO_DUE_GROUP_TEMPLATE_ID",
    name: "엘라노르_단체레슨_결제안내",
    content: `[엘라노르 댄스학원] 수강권 만료 예정 안내

안녕하세요, #{회원명}님!
엘라노르 댄스학원입니다. ✨

회원님께서 수강 중이신 #{수업명} 클래스 수강권이 1주일 후 만료될 예정입니다.

• 수강 클래스: #{수업명}
• 만료 예정일: #{만료예정일}
• 사용 가능 횟수: #{잔여횟수}회

이용에 불편함이 없으시도록 만료 예정일을 미리 확인해 주시기 바랍니다.

궁금하신 점은 언제든 편하게 문의해 주세요! 오늘도 좋은 하루 보내세요. 💛`
  }
];

const existingResponse = await request(
  `/kakao/v2/templates/?channelId=${encodeURIComponent(channel.channelId)}&isMine=true&limit=100`
);
const existing = existingResponse.templateList ?? [];
const provisioned = [];

for (const definition of definitions) {
  const matches = existing.filter((template) => template.name === definition.name && !template.isDeleted);
  if (matches.length > 1) {
    throw new Error(`${definition.name}: 같은 이름의 템플릿이 여러 개입니다.`);
  }

  let template = matches[0];
  if (template && template.content !== definition.content) {
    if (!updateExisting) {
      throw new Error(
        `${definition.name}: 기존 템플릿 문구가 코드와 다릅니다. 수정하려면 --update-existing을 사용하세요.`
      );
    }
    if (template.status === "INSPECTING") {
      template = await request(
        `/kakao/v2/templates/${encodeURIComponent(template.templateId)}/inspection/cancel`,
        { method: "PUT" }
      );
    }
    if (template.status === "APPROVED") {
      const replacementName = `${definition.name}_v2`;
      const replacements = existing.filter(
        (candidate) => candidate.name === replacementName && !candidate.isDeleted
      );
      if (replacements.length > 1) {
        throw new Error(`${replacementName}: 같은 이름의 템플릿이 여러 개입니다.`);
      }
      template = replacements[0];
      if (template && template.content !== definition.content) {
        if (template.status === "INSPECTING") {
          template = await request(
            `/kakao/v2/templates/${encodeURIComponent(template.templateId)}/inspection/cancel`,
            { method: "PUT" }
          );
        }
        if (template.status === "APPROVED") {
          throw new Error(`${replacementName}: 승인된 v2 템플릿은 자동으로 덮어쓰지 않습니다.`);
        }
        template = await request(`/kakao/v2/templates/${encodeURIComponent(template.templateId)}`, {
          method: "PUT",
          body: JSON.stringify({
            content: definition.content,
            categoryCode: "003001",
            messageType: "BA",
            emphasizeType: "NONE",
            securityFlag: false
          })
        });
      }
      if (!template) {
        template = await request("/kakao/v2/templates", {
          method: "POST",
          body: JSON.stringify({
            channelId: channel.channelId,
            name: replacementName,
            content: definition.content,
            categoryCode: "003001",
            messageType: "BA",
            emphasizeType: "NONE",
            securityFlag: false
          })
        });
      }
    } else {
      template = await request(`/kakao/v2/templates/${encodeURIComponent(template.templateId)}`, {
        method: "PUT",
        body: JSON.stringify({
          content: definition.content,
          categoryCode: "003001",
          messageType: "BA",
          emphasizeType: "NONE",
          securityFlag: false
        })
      });
    }
  }
  if (!template) {
    template = await request("/kakao/v2/templates", {
      method: "POST",
      body: JSON.stringify({
        channelId: channel.channelId,
        name: definition.name,
        content: definition.content,
        categoryCode: "003001",
        messageType: "BA",
        emphasizeType: "NONE",
        securityFlag: false
      })
    });
  }

  if (template.status === "PENDING") {
    template = await request(`/kakao/v2/templates/${encodeURIComponent(template.templateId)}/inspection`, {
      method: "PUT",
      body: JSON.stringify({ comment: "댄스학원 수강 등록 및 결제 예정 안내용 정보성 메시지입니다." })
    });
  }

  provisioned.push({
    env: definition.env,
    templateId: template.templateId,
    status: template.status
  });
}

console.log(
  JSON.stringify(
    {
      channelId: channel.channelId,
      channelName: channel.channelName,
      senderPhone,
      templates: provisioned
    },
    null,
    2
  )
);
