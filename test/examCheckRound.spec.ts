import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldRunCheck } from '../shared/answerCheck';

describe('shouldRunCheck', () => {
  const code = '思路\n```cpp\nint main(){}\n```\n复杂度 O(1)';

  it('runs for the technical sub-mode', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: '实现一个 LRU', answer: code, fromBank: false })).toBe(true);
  });

  it('runs when an open-mode question is clearly a coding question', () => {
    expect(shouldRunCheck({ subMode: 'open', question: '用 LeetCode 风格写一道算法题的解：两数之和', answer: code, fromBank: false })).toBe(true);
  });

  it('never runs on a bank-direct answer — the bank is already the certainty here', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: 'q', answer: code, fromBank: true })).toBe(false);
  });

  it('stays out of aptitude and personality items', () => {
    expect(shouldRunCheck({ subMode: 'aptitude', question: '下列说法正确的是 A.甲 B.乙', answer: '选 A', fromBank: false })).toBe(false);
    expect(shouldRunCheck({ subMode: 'personality', question: '我常感到精力充沛', answer: '选「非常符合」', fromBank: false })).toBe(false);
  });

  it('has nothing to check in an empty answer', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: 'q', answer: '  ', fromBank: false })).toBe(false);
  });
});

/**
 * One round at a time, in the process that pays for them. `electron/main.ts` is
 * the Electron entry point — importing it starts the app — so this asserts the
 * guard's shape where the money actually leaves: a second concurrent round for
 * one requestId would overwrite examControllers[requestId] and orphan the first
 * round's abort handle, so 停止 would cancel the wrong round.
 */
describe('requestExamCheck 的单回合上限（主进程源码形状）', () => {
  const src = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const run = src.slice(src.indexOf('const runExamCheck = async'), src.indexOf('const requestExamCheck'));
  const manual = src.slice(src.indexOf('const requestExamCheck'), src.indexOf('ipcMain.on(IPC.examCheck'));

  it('declares the in-flight set next to the round state', () => {
    // the slices above must be real: a rename fails here, not as a silent no-match
    expect(src.indexOf('const runExamCheck = async')).toBeGreaterThan(-1);
    expect(src.indexOf('const requestExamCheck')).toBeGreaterThan(-1);
    expect(src).toMatch(/const checkRunning = new Set<string>\(\)/);
    expect(run).toContain('checkRunning');
  });

  it('refuses a second round before it touches examControllers', () => {
    const guard = run.indexOf('if (checkRunning.has(requestId))');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(run.indexOf('examControllers.set(requestId, ac)'));
  });

  it('claims the slot before the request goes out and releases it in the finally', () => {
    expect(run.indexOf('checkRunning.add(requestId)')).toBeLessThan(run.indexOf('try {'));
    expect(run).toMatch(/finally \{[^}]*examControllers\.delete\(requestId\);[^}]*checkRunning\.delete\(requestId\);/);
  });

  it('a rejected manual press neither spends a call nor advances the turn counter', () => {
    const guard = manual.indexOf('checkRunning.has(requestId)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(manual.indexOf('const turn = (checkTurns.get(requestId)'));
  });
});
