export const QUESTION_MAX_CHARS = 500;
export const ANSWER_MAX_CHARS = 800;
export const CONTEXT_MAX_CHARS = 6000;
export const POLITICAL_TOPIC_MESSAGE = '这类当代政治话题暂不在本站问答范围内，请换个问题。';

// shortcut: 这是本站范围的高置信初筛，绕写和隐晦表述仍须由问答模型按语义再判断。
const politicalPatterns = [
  /(?:现任|当今|当代|目前|现在|下一任|竞选).{0,16}(?:政治人物|总统|首相|总理|国家领导人)|(?:总统|首相|总理|国家主席|国家领导人)(?!奖学金)/u,
  /(?:政党|执政党|反对党|在野党|共产党|国民党|民主党|共和党|工党|保守党|自民党).{0,30}(?:评价|怎么看|怎么样|支持|反对|喜欢|好不好|更好|好坏|优劣|执政|腐败|专制)|(?:评价|支持|反对).{0,20}(?:政党|执政党|反对党|在野党|共产党|国民党|民主党|共和党|工党|保守党|自民党)/u,
  /(?:政府|当局|政权).{0,24}(?:评价|怎么看|怎么样|好坏|优劣|腐败|专制|独裁|合法性|倒台)|(?:评价|支持|反对|推翻).{0,20}(?:政府|当局|政权)/u,
  /(?:当代|现代|现行).{0,16}(?:政治制度|民主制度|一党制|多党制)|(?:民主|独裁|专制|一党制|多党制).{0,24}(?:优劣|优越|孰优|哪个好|比较|争议)|(?:政治制度|民主制度).{0,16}(?:争议|优劣|哪个好)/u,
  /(?:国际政治|地缘政治|国际关系).{0,30}(?:争议|冲突|对错|评价|立场|支持|反对)|(?:俄乌|巴以|印巴|两岸).{0,20}(?:战争|冲突|争议|关系|统一|独立)|(?:南海|台海|领土|主权|边界).{0,16}(?:争端|争议|冲突)|(?:台湾|香港|西藏|苏格兰|加泰罗尼亚).{0,12}(?:独立|主权)/u,
  /(?:政治|政党|政府|政权|总统|议会).{0,24}(?:动员|游行|示威|抗议|竞选|拉票|投票)|(?:组织|号召|参加).{0,16}(?:政治游行|政治示威|反政府|推翻政府)/u,
  /\b(?:president|prime minister)\b|\b(?:political part(?:y|ies)|government|regime)\b.{0,35}\b(?:support|oppose|evaluate|corrupt|dictator|overthrow)\b|\b(?:international|geopolitical)\b.{0,25}\b(?:conflict|dispute|controversy)\b/iu,
];

export function politicalTopicReason(value) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return politicalPatterns.some(pattern => pattern.test(text)) ? 'politics' : null;
}
