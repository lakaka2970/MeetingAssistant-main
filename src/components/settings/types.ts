import type { ThinkingCapability, ThinkingLevel } from '../../../shared/thinking';

export type SettingsTab =
  | 'model'
  | 'routing'
  | 'asr'
  | 'vision'
  | 'knowledge'
  | 'health'
  | 'general';

/** select bound to one thinking slot; empty = 跟随默认 (send nothing) */
export interface ThinkingBinding {
  value: string;
  cap: ThinkingCapability | undefined;
  set: (v: ThinkingLevel | '') => void;
}
