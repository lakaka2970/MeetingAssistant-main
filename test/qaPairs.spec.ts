import { describe, it, expect } from 'vitest';
import {
  extractQaPairs,
  formatQaRecord,
  normalizeQuestion,
  parseQaRecord,
  questionSimilarity,
} from '../shared/qaPairs';

const q = (text: string) => extractQaPairs(text)[0];

describe('extractQaPairs (auto-detected prepared answers)', () => {
  it('reads the plain 问：/答： style', () => {
    const pairs = extractQaPairs(`问：你为什么离开上一家公司？
答：团队解散了，我想找一个更稳定的技术团队继续深耕。

问：你的缺点是什么？
答：我有时候过于追求细节，现在会先保证整体进度。`);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe('你为什么离开上一家公司');
    expect(pairs[0].answer).toBe('团队解散了，我想找一个更稳定的技术团队继续深耕。');
    expect(pairs[1].question).toBe('你的缺点是什么');
    expect(pairs[0].via).toBe('marker');
  });

  it('reads Q:/A: with markdown bold and blockquote decorations', () => {
    const p = q(`> **Q:** What is your salary expectation?
> **A:** I expect a market rate for a senior engineer, around 30k per month.`);
    expect(p.question).toBe('What is your salary expectation');
    expect(p.answer).toContain('market rate');
    expect(p.via).toBe('marker');
  });

  it('reads 【问题】/【回答】 and Question/Answer variants', () => {
    const a = q(`【问题】请做一下自我介绍
【回答】我是三年经验的后端工程师，主导过支付对账系统重构。`);
    const b = q(`Question: How do you handle conflict in a team?
Answer: I first restate the other side's position, then look for the shared goal.`);
    expect(a.question).toBe('请做一下自我介绍');
    expect(a.answer).toContain('支付对账');
    expect(b.question).toBe('How do you handle conflict in a team');
    expect(b.answer).toContain('shared goal');
  });

  it('a heading question needs no answer marker', () => {
    const p = q(`## 什么是 CAP 定理？
CAP 指一致性、可用性、分区容错性，分布式系统三选二，分区容错必须保证，
所以实际是在 C 和 A 之间取舍。`);
    expect(p.via).toBe('question');
    expect(p.question).toBe('什么是 CAP 定理');
    expect(p.answer).toContain('三选二');
  });

  it('a bare question line without enough body is not a pair', () => {
    const pairs = extractQaPairs(`有什么问题吗？
没有。`);
    expect(pairs).toHaveLength(0);
  });

  it('keeps fenced code inside the answer (coding prep)', () => {
    const p = q(`问：写一个两数之和
答：用哈希表，一次遍历：

\`\`\`python
def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            return [seen[target - n], i]
        seen[n] = i
\`\`\`
`);
    expect(p.answer).toContain('```python');
    expect(p.answer).toContain('two_sum');
  });

  it('multi-line question after an empty marker body', () => {
    const p = q(`**Q:**
你如何评估一个项目是否值得做？
从收益、成本、风险三方面评估，先看能不能量化收益。`);
    expect(p.question).toContain('值得做');
  });

  it('never harvests ordinary prose or section headers', () => {
    const pairs = extractQaPairs(`## 教育经历
2015-2019 某大学 计算机科学与技术 本科

负责过订单中心的重构，QPS 提升三倍。`);
    expect(pairs).toHaveLength(0);
  });

  it('drops a question with no answer at all', () => {
    expect(extractQaPairs('问：你还有什么想问的？')).toHaveLength(0);
  });

  it('an answer runs to the next question (document order)', () => {
    const p = q(`问：你的短板是什么？
答：有时过于追求细节。

后面这段是同一小节里的补充说明，也属于这个答案。`);
    expect(p.answer).toContain('过于追求细节');
    expect(p.answer).toContain('补充说明');
  });

  it('a horizontal rule closes an answer (trailing prose never rides along)', () => {
    const pairs = extractQaPairs(`问：你的短板是什么？
答：有时过于追求细节，现在会先保整体进度。

---

以下是与问答无关的其它段落，写得再长也不应并进上面的答案。`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toBe('有时过于追求细节，现在会先保整体进度。');
  });

  it('deduplicates the same question, keeping the first', () => {
    const pairs = extractQaPairs(`问：自我介绍
答：我叫张三，三年 Java 后端经验。

问：自我介绍
答：重复的一份。`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toContain('张三');
  });

  it('survives a mixed real-world note file', () => {
    const pairs = extractQaPairs(`# 面试准备

1. 问：为什么选择我们公司？
   答：因为贵司的推荐系统规模和我的经验匹配。

2. Q: 你最大的项目成就是什么？
   A: 主导了实时特征平台，延迟从 200ms 降到 30ms。

## 反问环节
你有什么想问面试官的吗？
可以问团队的技术栈、迭代节奏和晋升机制。
`);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs.some((p) => p.answer.includes('延迟'))).toBe(true);
  });
});

// ---- the grammars a real 290-file interview library actually uses ----

describe('extractQaPairs — real-world note grammars', () => {
  it('reads a numbered heading question with no space after the dot', () => {
    const p = q(`### 1.线程池了解吗？参数有哪些？任务到达线程池的过程？
核心参数是核心线程数、最大线程数、队列长度和拒绝策略。
任务到达后先看核心线程是否空闲，否则入队，队满再扩线程。`);
    expect(p.question).toContain('线程池了解吗');
    expect(p.question).not.toMatch(/^\d/);
    expect(p.answer).toContain('拒绝策略');
  });

  it('peels multi-level numbering (1.1) off a heading question', () => {
    const p = q(`### 1.1 为什么 FastAPI 是 AI 服务的首选？
因为它的异步原生、自动文档和类型校验，让我们能把模型服务直接暴露成 REST。`);
    expect(p.question).toBe('为什么 FastAPI 是 AI 服务的首选');
  });

  it('keeps a leading year — only enumeration is stripped, not any number', () => {
    const p = q(`### 2024 年发生了什么重要的技术变化？
大模型推理成本下降了一个数量级，端侧部署成为主流方向之一。`);
    expect(p.question).toBe('2024 年发生了什么重要的技术变化');
  });

  it('reads numbered Q1:/A2: markers', () => {
    const pairs = extractQaPairs(`### Q1: FastAPI 和 Flask 的区别？
A1: FastAPI 原生异步、自动校验类型并生成 OpenAPI 文档。

### Q2: 为什么选它做模型服务？
A2: 因为异步 I/O 能把 GPU 等待时间藏起来，吞吐更高。`);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe('FastAPI 和 Flask 的区别');
    expect(pairs[1].answer).toContain('GPU');
  });

  it('reads a 高频考点 → 一句话要点 table', () => {
    const pairs = extractQaPairs(`# 快速自查表

| # | 高频考点 | 一句话要点 |
|---|---|---|
| 1 | Kafka 如何保证不丢消息 | 生产端 acks=all、刷盘、副本数≥3、消费端手动提交位移 |
| 2 | 消费者组重平衡何时发生 | 成员增减、订阅变化或分区数变化时触发 |
`);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].via).toBe('table');
    expect(pairs[0].question).toBe('Kafka 如何保证不丢消息');
    expect(pairs[0].answer).toContain('acks=all');
    expect(pairs[1].question).toContain('重平衡');
  });

  it('reads 追问 → 应答要点 and 问题 → 简要答案 tables', () => {
    const a = extractQaPairs(`| 追问 | 应答要点 |
|:--|:--|
| 为什么不用 REST | gRPC 有强类型契约和二进制帧，跨语言成本更低 |`);
    const b = extractQaPairs(`| 问题 | 简要答案 | 详见 |
|---|---|---|
| 什么是过拟合 | 模型记住了噪声，训练误差低但泛化误差高 | [[03-过拟合]] |`);
    expect(a[0].answer).toContain('gRPC');
    expect(b[0].question).toBe('什么是过拟合');
    expect(b[0].answer).toContain('泛化误差');
    expect(b[0].answer).not.toContain('详见');
  });

  it('never harvests a comparison table as prepared answers', () => {
    const pairs = extractQaPairs(`| 特性 | Kafka | RabbitMQ | Redis Stream |
|---|---|---|---|
| 吞吐 | 极高 | 中等 | 高 |
| 顺序 | 分区内有序 | 队列级 | 单流有序 |`);
    expect(pairs).toEqual([]);
  });

  it('never harvests a 并发问题/说明/示例 table (no question-shaped column)', () => {
    const pairs = extractQaPairs(`| 并发问题 | 说明 | 示例 |
|---|---|---|
| 丢失更新 | 两个事务都写同一行 | 扣款重复执行 |
| 脏读 | 读到未提交数据 | A 回滚 B 已读 |`);
    expect(pairs).toEqual([]);
  });

  it('skips placeholder table rows, keeps the real ones', () => {
    const pairs = extractQaPairs(`| 考点 | 要点 |
|---|---|
| 闭包 | 函数与其词法环境的组合，常用于封装私有状态与柯里化 |
| — | – |
| 待补充 | 短 |`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe('闭包');
  });

  it('a table cannot be swallowed by an open prose answer', () => {
    const pairs = extractQaPairs(`问：聊聊你的项目
答：这个项目我负责端侧推理加速。

| 追问 | 应答要点 |
|---|---|
| 量化掉了多少精度 | int8 量化后 mAP 掉 0.6 个点，在可接受范围内 |`);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].answer).toBe('这个项目我负责端侧推理加速。');
    expect(pairs[1].via).toBe('table');
  });

  it('collapses a markdown link and drops a （高频考点） annotation from a question cell', () => {
    const pairs = extractQaPairs(`| 考点 | 一句话要点 |
|---|---|
| [Flash Attention](https://example.com/zhihu?q=1) | 把注意力算子分块计算，减少显存往返 |
| 如何保证消息不丢失（高频考点） | 生产端 acks=all、消费端手动提交、副本数≥3 |`);
    expect(pairs[0].question).toBe('Flash Attention');
    expect(pairs[0].question).not.toContain('http');
    expect(pairs[1].question).toBe('如何保证消息不丢失');
  });

  it('ignores a cell that only echoes the column header', () => {
    const pairs = extractQaPairs(`| 问题 | 简要答案 |
|---|---|
| 问题 | 这是把表头重复写进单元格的脏数据，不该成为一道题 |
| 什么是幂等 | 同一请求重复执行的结果与执行一次相同，靠唯一键去重实现 |`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe('什么是幂等');
  });
});

describe('question similarity helpers', () => {
  it('normalizes case, spacing and punctuation into one key', () => {
    expect(normalizeQuestion('什么是 CAP 定理?')).toBe(normalizeQuestion('什么是cap定理'));
    expect(normalizeQuestion('Tell me about yourself。')).toBe(normalizeQuestion('tell me about yourself'));
  });

  it('scores identical / near / unrelated questions apart', () => {
    expect(questionSimilarity('你为什么要离职', '你为什么要离职？')).toBe(1);
    expect(questionSimilarity('介绍下你的项目', '介绍一下你的项目经历')).toBeGreaterThanOrEqual(0.5);
    expect(questionSimilarity('介绍下你的项目', '你期望薪资多少')).toBeLessThan(0.2);
  });

  it('round-trips the stored record format', () => {
    const rec = formatQaRecord('什么是 X', 'X 是 Y');
    expect(rec).toBe('问：什么是 X\n\n答：X 是 Y');
    expect(parseQaRecord(rec)).toEqual({ question: '什么是 X', answer: 'X 是 Y' });
  });
});
