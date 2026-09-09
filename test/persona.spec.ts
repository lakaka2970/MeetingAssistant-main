import { describe, it, expect } from 'vitest';
import {
  TRAIT_LABELS,
  buildPersonaBlock,
  checkContradiction,
  clampLevel,
  defaultPersona,
  detectDims,
  impliedPole,
  isReverseWorded,
  parsePersona,
  pickForced,
  pickLikert,
  updateLedger,
  type Ledger,
} from '../shared/persona';

const persona = defaultPersona('后端工程师');
const target = (dim: string) => persona.targets.find((t) => t.dim === dim)!;

describe('pickLikert — consistent with the target, never over-perfect', () => {
  it('stops short of the extreme on a normal dimension', () => {
    expect(pickLikert(2, 5)).toBe(4);
    expect(pickLikert(2, 5, { hardGate: true })).toBe(5);
    expect(pickLikert(1, 5)).toBe(4);
    expect(pickLikert(0, 5)).toBe(3);
    expect(pickLikert(-1, 5)).toBe(2);
    expect(pickLikert(-2, 5)).toBe(2);
  });

  it('scales to 7-point instruments without leaving the range', () => {
    for (const level of [-2, -1, 0, 1, 2] as const) {
      const picked = pickLikert(level, 7);
      expect(picked).toBeGreaterThanOrEqual(1);
      expect(picked).toBeLessThanOrEqual(7);
    }
    expect(pickLikert(2, 7)).toBe(6);
  });

  it('tolerates a nonsense scale', () => {
    expect(pickLikert(1, 99)).toBeLessThanOrEqual(7);
    expect(pickLikert(1, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe('dimension reading and direction', () => {
  it('finds the dimension an item is about', () => {
    expect(detectDims('我做事总会反复检查有没有出错')).toEqual(
      expect.arrayContaining(['detail']),
    );
    expect(detectDims('被领导当众批评时我很难平静')).toEqual(expect.arrayContaining(['stability']));
    expect(detectDims('今天天气不错')).toEqual([]);
  });

  it('flags reverse-worded items and flips the implied pole', () => {
    expect(isReverseWorded('我不容易紧张', 'stability')).toBe(true);
    expect(isReverseWorded('我容易紧张', 'stability')).toBe(false);
    const dims = detectDims('我容易紧张');
    // agreeing to the plain item commits "low stability"; agreeing to its
    // reverse wording commits "high stability"
    expect(impliedPole(true, '我容易紧张', dims)).toBe('high');
    expect(impliedPole(true, '我不容易紧张', dims)).toBe('low');
    expect(impliedPole(false, '我不容易紧张', dims)).toBe('high');
  });

  it('clamps garbage levels', () => {
    expect(clampLevel(9)).toBe(2);
    expect(clampLevel(-40)).toBe(-2);
    expect(clampLevel('1')).toBe(1);
    expect(clampLevel(undefined)).toBe(0);
  });
});

describe('the ledger — what makes a run of answers close', () => {
  it('needs two prior answers before calling anything a pattern', () => {
    let ledger: Ledger = {};
    ({ ledger } = updateLedger(ledger, '我容易紧张', false));
    expect(checkContradiction(ledger, '我容易紧张', true)).toBeNull();
    ({ ledger } = updateLedger(ledger, '我在紧急情况下会紧张', false));
    const warn = checkContradiction(ledger, '我容易紧张', true);
    expect(warn?.dim).toBe('stability');
    expect(warn?.message).toContain('一致性');
  });

  it('lets a consistent answer through', () => {
    let ledger: Ledger = {};
    for (const item of ['我容易紧张', '我在紧急情况下会紧张']) {
      ({ ledger } = updateLedger(ledger, item, false));
    }
    expect(checkContradiction(ledger, '我不容易紧张', true)).toBeNull();
  });

  it('counts an unknown-dimension item without inventing a pole', () => {
    const { ledger, dims, pole } = updateLedger({}, '随便一句无关的话', true);
    expect(dims).toEqual([]);
    expect(pole).toBeUndefined();
    expect(Object.keys(ledger)).toHaveLength(0);
  });
});

describe('pickForced — 迫选二选一', () => {
  it('chooses the statement aligned with the target persona', () => {
    const pick = pickForced(persona, {}, [
      '我更喜欢按既定流程稳妥地完成工作',
      '我总想尝试没做过的新方法',
    ]);
    expect(pick?.index).toBe(0);
    expect(pick?.reason).toContain('目标画像');
  });

  it('refuses to guess when neither option maps to a dimension', () => {
    expect(pickForced(persona, {}, ['我喜欢苹果', '我喜欢香蕉'])).toBeUndefined();
  });

  it('breaks ties toward what has already been committed', () => {
    const ledger: Ledger = { conscientiousness: { pole: 'high', times: 3 } };
    const pick = pickForced(
      persona,
      ledger,
      ['我会先把事情做完再玩', '我会先玩再做别的'],
    );
    expect(pick?.index).toBe(0);
  });

  it('needs at least two options', () => {
    expect(pickForced(persona, {}, ['只有一项'])).toBeUndefined();
  });
});

describe('buildPersonaBlock / parsePersona', () => {
  const block = buildPersonaBlock(persona, { integrity: { pole: 'high', times: 2 } });

  it('carries the targets, the committed directions and all four rules', () => {
    expect(block).toContain('【性格测评人设】');
    expect(block).toContain(TRAIT_LABELS.integrity);
    expect(block).toContain('已答 2 次');
    expect(block).toContain('反向表述');
    expect(block).toContain('测谎');
    expect(block).toContain('迫选');
    // a high-target dimension carries its concrete scale position
    expect(block).toMatch(/诚信\/规则：偏高（选第 5 档）/);
  });

  it('accepts the shapes a research call or a hand-written file produces', () => {
    const p = parsePersona({
      role: '算法工程师',
      targets: [
        { dim: 'integrity', level: 2, why: '红线' },
        { dimension: '抗压/强度适应', level: 1, reason: '版本节奏' },
        { dim: 'integrity', level: -2 }, // duplicate ignored
        { dim: 'not-a-dimension', level: 1 }, // unknown ignored
      ],
    });
    expect(p?.targets.map((t) => t.dim)).toEqual(['integrity', 'resilience']);
    expect(p?.targets[1].level).toBe(1);
    expect(p?.source).toBe('researched');
  });

  it('returns null instead of a half persona', () => {
    expect(parsePersona(null)).toBeNull();
    expect(parsePersona('{}')).toBeNull();
    expect(parsePersona({ targets: [{ dim: 'x', level: 1 }] })).toBeNull();
  });
});
