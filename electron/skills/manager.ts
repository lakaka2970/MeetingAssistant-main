/**
 * Skills system (upgrade P3): tiny markdown files with YAML-ish frontmatter
 * that steer the free-ask LLM behaviour via a typed trigger (e.g. /star).
 * Pure parsing logic here (unit-testable); loading touches fs only.
 *
 * A skill file looks like:
 *   ---
 *   name: behavioral_star
 *   trigger: /star
 *   description: 用 STAR 框架回答行为面问题
 *   ---
 *   当用户使用此技能时，行为面回答一律按 STAR 展开……
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Skill {
  name: string;
  trigger: string;
  description: string;
  /** body below the frontmatter — the directive injected into the prompt */
  instruction: string;
  /** origin file (diagnostics/UI) */
  file: string;
}

/** parse `key: value` frontmatter + body. null = not a valid skill file. */
export function parseSkillMd(content: string, file = ''): Skill | null {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();

  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  const name = meta.name;
  const trigger = meta.trigger;
  if (!name || !trigger || !trigger.startsWith('/')) return null;
  if (!body) return null;
  return {
    name,
    trigger,
    description: meta.description ?? '',
    instruction: body,
    file,
  };
}

export class SkillsManager {
  private skills: Skill[] = [];

  /** load from multiple dirs; later dirs win on trigger collisions */
  loadFromDirs(dirs: string[]): void {
    const byTrigger = new Map<string, Skill>();
    for (const dir of dirs) {
      let entries: string[] = [];
      try {
        if (!existsSync(dir)) continue;
        entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
      } catch {
        continue;
      }
      for (const file of entries) {
        try {
          const skill = parseSkillMd(readFileSync(join(dir, file), 'utf8'), join(dir, file));
          if (skill) byTrigger.set(skill.trigger, skill);
        } catch {
          /* an unreadable file must never break the app */
        }
      }
    }
    this.skills = [...byTrigger.values()].sort((a, b) => a.trigger.localeCompare(b.trigger));
  }

  list(): Skill[] {
    return [...this.skills];
  }

  /** longest-trigger-prefix match (so /star2 wins over /star) */
  match(input: string): Skill | null {
    const text = input.trim();
    if (!text.startsWith('/')) return null;
    let best: Skill | null = null;
    for (const s of this.skills) {
      if (text.startsWith(s.trigger) && (!best || s.trigger.length > best.trigger.length)) {
        best = s;
      }
    }
    return best;
  }

  /** strip the trigger from the input; returns null when it did not match */
  stripTrigger(input: string, skill: Skill): string | null {
    const text = input.trim();
    if (!text.startsWith(skill.trigger)) return null;
    return text.slice(skill.trigger.length).trim();
  }
}
