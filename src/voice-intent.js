// Only route explicit speech requests. Discussion of the voice feature stays in chat.
const TEST_SPEECH = "语音测试成功，我可以给你发语音条了。";
const JOKE_SPEECH = "我本来想讲个冷笑话，结果空调说：这活儿它熟。";
const GREETING_SPEECH = "嗨，我是小跟班！今天过得怎么样？";

function stripLeadingBotAddress(text, addressNames) {
  let input = text.trim().replace(/^(?:\[引用消息\]\s*)+/u, "").trim();
  const names = [...new Set(addressNames.map((name) => String(name || "").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const prefix = `@${name}`;
    if (input.startsWith(prefix) && (!input[prefix.length] || /[\s,，:：]/u.test(input[prefix.length]))) {
      input = input.slice(prefix.length).replace(/^[\s,，:：]+/u, "").trim();
      break;
    }
  }
  return input;
}

export function detectVoiceReplyIntent(text, { addressed = false, addressNames = [] } = {}) {
  if (!addressed || typeof text !== "string") return null;
  const input = stripLeadingBotAddress(text, addressNames);
  if (!input || input.startsWith("/") || input.length > 400) return null;
  if (/(?:怎么|如何|为什么|能不能|可不可以|是否|支持|失败|不能|无法|问题|配置|设置).{0,12}(?:发|发送|回复|生成)?语音/.test(input)
    || /(?:语音识别|语音转写|语音功能|语音配置|语音消息.{0,6}怎么)/.test(input)) return null;

  const request = input.replace(/^(?:(?:请|麻烦|帮我|给我|你|小跟班)[，,\s]*)/u, "");
  if (/^(?:用语音|发语音|语音回复)(?:吧|呀|啊|呗)?[。！!\s]*$/u.test(request)) {
    return { kind: "followup", text: "" };
  }
  if (/^(?:用语音|语音)(?:给我)?(?:发|说|念|读|讲)(?:一遍|一次|出来)(?:吧|呀|啊|呗)?[。！!\s]*$/u.test(request)
    || /^(?:再|重新)(?:用语音|发语音)(?:发|说|念|读|讲)?(?:一遍|一次)(?:吧|呀|啊|呗)?[。！!\s]*$/u.test(request)
    || /^(?:没有|还没|没)(?:用语音|发语音)(?:发出来|发出|发)(?:啊|呀|呢|吧)?[。！!\s]*$/u.test(request)) {
    return { kind: "repeat", text: "" };
  }
  const greeting = request.match(/^(?:(?:用语音|语音)(?:给我|跟我)?|(?:发|发送)(?:一条|一个|条|个|段)?语音(?:给我)?[，,\s]*)(?:打个招呼|问个好|说声你好)(?:吧|呀|啊|呗)?[。！!\s]*$/u);
  if (greeting) return { kind: "greeting", text: GREETING_SPEECH };
  const introduction = request.match(/^(?:用语音|语音)(?:给我|跟我)?(介绍|讲讲|描述)(.{1,300})$/u);
  if (introduction) return { kind: "answer", text: `${introduction[1]}${introduction[2]}`.slice(0, 350) };
  const action = request.match(/^(?:(?:再|再次)?测试(?:一下)?(?:发送|发)?语音|(?:再|再次)?语音测试|(?:再|再次)?(?:发|发送)(?:一条|一个|条|个|段)?语音(?:给我)?|(?:用语音|语音)(?:给我|跟我)?(?:回复|回答|说|念|读|讲)(?:我)?)(.*)$/u);
  if (!action) return null;
  const tail = action[1].replace(/^[，,。！!：:\s]+/u, "").trim();
  if (!tail) return { kind: "test", text: TEST_SPEECH };
  if (/^(?:[?？]|怎么|如何|为什么|能不能|可不可以|是否)/u.test(tail)) return null;

  const requestedSpeech = tail.replace(/^(?:说|念|读|播报|讲|来|给我)[：:\s]*/u, "").trim();
  if (/^(?:一?(?:句|个|段))?(?:开玩笑的话|好笑的话|有趣的话|笑话|段子)(?:吧|呀|啊|给我听|来听听)?[。！!\s]*$/u.test(requestedSpeech)) {
    return { kind: "joke", text: JOKE_SPEECH };
  }
  if ((/^(?:说|念|读|播报)/u.test(tail) || /^(?:用语音|语音)(?:给我)?(?:说|念|读)/u.test(request))
    && requestedSpeech && !/[?？]$/u.test(requestedSpeech)) {
    return { kind: "speak", text: requestedSpeech.slice(0, 350) };
  }
  if (/^(?:回答|回复|告诉我)/u.test(tail)) {
    const question = tail.replace(/^(?:回答|回复|告诉我)[：:\s]*/u, "").trim();
    if (question) return { kind: "answer", text: question.slice(0, 350) };
  }
  if (/^(?:再|再次)?(?:测试|试一下)/u.test(request)) return { kind: "test", text: TEST_SPEECH };
  return { kind: "answer", text: tail.slice(0, 350) };
}

export function shouldJudgeVoiceReplyIntent(text, { addressed = false } = {}) {
  if (!addressed || typeof text !== "string") return false;
  const input = text.trim();
  return input.length > 0 && input.length <= 400 && !input.startsWith("/")
    && /(?:语音|语音条|声音|开口说|说给我听|讲给我听|念给我听|读给我听|听你说|听你讲)/u.test(input);
}
