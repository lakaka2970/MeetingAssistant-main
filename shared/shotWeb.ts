/**
 * 截屏问答 fallback decision (sub-project ③ follow-up): the hotkey pipeline
 * answers from the local sources first — the bound 题库 and the session's RAG
 * material. The web is consulted only when BOTH stayed silent, and when the
 * user wants the web but it cannot actually run, the silence must be explained
 * (a one-shot note) rather than mistaken for a dead pipeline.
 */

export interface ShotWebInput {
  /** the 题库 produced a usable hit */
  bankHit: boolean;
  /** the session's RAG material retrieval returned content */
  ragHit: boolean;
  /** settings.data.exam.webFallback — the user opted into web fallback */
  webFallback: boolean;
  /** provider enabled AND an API key is configured */
  webConfigured: boolean;
}

export interface ShotWebDecision {
  /** run the web search for this question */
  run: boolean;
  /** tell the user why no web supplement came */
  hint: boolean;
}

export function decideShotWeb(i: ShotWebInput): ShotWebDecision {
  if (i.bankHit || i.ragHit) return { run: false, hint: false };
  if (i.webFallback && i.webConfigured) return { run: true, hint: false };
  // the user opted into the web but it cannot run — say so once, rather than
  // letting the silence read as a dead pipeline. Switched off is their choice.
  return { run: false, hint: i.webFallback };
}

/**
 * Whole-screen shot: does this machine raise the exam window? When the
 * dual-screen companion is on, the paired device is THE display (every exam
 * event is published to it regardless), so popping a window here is noise the
 * user explicitly does not want. hotkeyToPhone governs the region-crop hotkey
 * routing only — it does not resurrect the popup for the whole-screen shot.
 */
export function shouldRaiseLocalExamWindow(
  companion: { enabled?: boolean; hotkeyToPhone?: boolean } | undefined,
): boolean {
  return !companion?.enabled;
}
