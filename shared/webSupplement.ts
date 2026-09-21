/**
 * The 先答后补 supplement call (pipeline-latency ③): the main answer has
 * already streamed WITHOUT web context (the search must never hold back the
 * first token), so this second small call contributes only what the results
 * add on top of the answer the user already sees.
 *
 * The supplement is delivered as ONE block, not a live stream — that is what
 * lets the sentinel work: a "nothing to add" reply never touches the screen.
 *
 * Pure — no electron, no network.
 */
export const NO_SUPPLEMENT = 'NO_SUPPLEMENT';

export function supplementMessages(
  question: string,
  mainAnswer: string,
  webLines: string[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        '你是补充检索助手。给定【问题】【已有回答】与【搜索结果】，只输出搜索结果里【已有回答没提到】的实质补充要点。',
        '要求：直接列要点（每行一条，最多 4 条）；不复述已有回答；不写开场语、不写总结；用与问题相同的语言。',
        `若搜索结果没有可补充的信息，只输出 ${NO_SUPPLEMENT} 一个词，不要任何其它字符。`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `【问题】\n${question}\n\n【已有回答】\n${mainAnswer}\n\n【搜索结果】\n${webLines.join('\n')}\n\n补充要点（或 ${NO_SUPPLEMENT}）：`,
    },
  ];
}

/** the sentinel is only the sentinel when it is the whole reply */
export function isNoSupplement(text: string): boolean {
  return text.trim() === NO_SUPPLEMENT;
}
