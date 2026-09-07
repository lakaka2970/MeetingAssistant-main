import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSkillMd, SkillsManager } from '../electron/skills/manager';
import { extractMemoFacts, formatFactsHint } from '../electron/consistency/facts';

const STAR_SKILL = `---
name: behavioral_star
trigger: /star
description: 用 STAR 框架回答行为面问题
---
当用户使用此技能时，行为面回答一律按 STAR 展开。`;

const CODE_SKILL = `---
name: code_interview
trigger: /code
description: 编码题快速作答规范
---
编码题按 思路→代码→复杂度 作答。`;

function tempSkillDir(): string {
  return mkdtempSync(join(tmpdir(), 'mc-skills-'));
}

describe('parseSkillMd', () => {
  it('parses frontmatter and body', () => {
    const s = parseSkillMd(STAR_SKILL, 'behavioral_star.md');
    expect(s).not.toBeNull();
    expect(s!.name).toBe('behavioral_star');
    expect(s!.trigger).toBe('/star');
    expect(s!.description).toBe('用 STAR 框架回答行为面问题');
    expect(s!.instruction).toContain('STAR');
    expect(s!.file).toBe('behavioral_star.md');
  });

  it('rejects malformed files', () => {
    expect(parseSkillMd('no frontmatter')).toBeNull();
    expect(parseSkillMd('---\nname: x\n---\nbody')).toBeNull(); // no trigger
    expect(parseSkillMd('---\ntrigger: /x\n---\nbody')).toBeNull(); // no name
    expect(parseSkillMd('---\nname: x\ntrigger: x\n---\nbody')).toBeNull(); // trigger not /
    expect(parseSkillMd('---\nname: x\ntrigger: /x\n---\n')).toBeNull(); // empty body
  });
});

describe('SkillsManager', () => {
  it('loads .md files from dirs and matches trigger prefixes', () => {
    const dir = tempSkillDir();
    try {
      writeFileSync(join(dir, 'star.md'), STAR_SKILL, 'utf8');
      writeFileSync(join(dir, 'code.md'), CODE_SKILL, 'utf8');
      writeFileSync(join(dir, 'not-a-skill.txt'), '---\nname: x\ntrigger: /x\n---\nbody', 'utf8');

      const m = new SkillsManager();
      m.loadFromDirs([dir]);
      expect(m.list().map((s) => s.trigger).sort()).toEqual(['/code', '/star']);

      expect(m.match('/star 介绍你自己')?.name).toBe('behavioral_star');
      expect(m.match('/code 两数之和')?.name).toBe('code_interview');
      expect(m.match('star 不带斜杠')).toBeNull();
      const skill = m.match('/star')!;
      expect(m.stripTrigger('/star 介绍自己', skill)).toBe('介绍自己');
      expect(m.stripTrigger('/code', m.match('/code')!)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('later dirs win on trigger collisions', () => {
    const d1 = tempSkillDir();
    const d2 = tempSkillDir();
    try {
      writeFileSync(join(d1, 'a.md'), STAR_SKILL, 'utf8');
      writeFileSync(
        join(d2, 'b.md'),
        STAR_SKILL.replace('behavioral_star', 'override_star'),
        'utf8',
      );
      const m = new SkillsManager();
      m.loadFromDirs([d1, d2]);
      expect(m.match('/star')?.name).toBe('override_star');
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it('ignores non-slash input', () => {
    expect(new SkillsManager().match('hello')).toBeNull();
    expect(new SkillsManager().list()).toEqual([]);
  });
});

describe('extractMemoFacts', () => {
  const memo = [
    '【已问问题】',
    '自我介绍',
    'Redis 缓存设计',
    '【我已声称的事实】',
    '负责日活百万的直播系统',
    'QPS 峰值提升 3 倍',
    '',
    '【面试官关注点】',
    '高并发经验',
    '【注意事项】无',
  ].join('\n');

  it('extracts only the claimed-facts section, line by line', () => {
    expect(extractMemoFacts(memo)).toEqual(['负责日活百万的直播系统', 'QPS 峰值提升 3 倍']);
  });

  it('handles inline content after the section header (section runs to the next header)', () => {
    expect(extractMemoFacts('【我已声称的事实】带了 5 人小组\n其他段落')).toEqual([
      '带了 5 人小组',
      '其他段落',
    ]);
    // the next 【】 header ends the section
    expect(extractMemoFacts('【我已声称的事实】带了 5 人小组\n【注意事项】无')).toEqual(['带了 5 人小组']);
  });

  it('returns [] for empty/section-less memos', () => {
    expect(extractMemoFacts('')).toEqual([]);
    expect(extractMemoFacts('【已问问题】自我介绍')).toEqual([]);
  });

  it('drops too-short lines and caps the count', () => {
    const many = ['【我已声称的事实】', ...Array.from({ length: 40 }, (_, i) => `事实${i}：很长的描述文本`)].join('\n');
    expect(extractMemoFacts(many).length).toBeLessThanOrEqual(30);
    expect(extractMemoFacts('【我已声称的事实】\n短\n')).toEqual([]);
  });
});

describe('formatFactsHint', () => {
  it('renders a bullet list with the hard rule', () => {
    const hint = formatFactsHint(['QPS 提升 3 倍', '带了 5 人小组']);
    expect(hint).toContain('绝不能与之矛盾');
    expect(hint).toContain('- QPS 提升 3 倍');
  });
  it('is empty without facts', () => {
    expect(formatFactsHint([])).toBe('');
  });
});
