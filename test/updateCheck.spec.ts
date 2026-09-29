/**
 * The update-check decision logic, kept away from fetch and from Electron so it
 * can be read as a table.
 *
 * Two properties these tests exist to hold: a release tag is only "newer" when
 * it is actually newer (a rollback or a stray `v1.2` must not nag), and the
 * automatic path never fires more than once a day per install — the whole point
 * of the manual tray item is that a user chose to make a request.
 */
import { describe, expect, it } from 'vitest';
import { updateApiUrl } from '../electron/updateCheck';
import {
  UPDATE_CHECK_INTERVAL_MS,
  interpretRelease,
  isNewerVersion,
  parseReleaseTag,
  shouldAutoCheck,
} from '../shared/updateCheck';

describe('parseReleaseTag', () => {
  it('accepts the shapes GitHub tags actually come in', () => {
    expect(parseReleaseTag('v1.0.2')).toBe('1.0.2');
    expect(parseReleaseTag('1.0.2')).toBe('1.0.2');
    expect(parseReleaseTag('V1.2.10')).toBe('1.2.10');
  });

  it('refuses anything that is not a version, rather than guessing', () => {
    expect(parseReleaseTag('latest')).toBeNull();
    expect(parseReleaseTag('1.0.2-beta.1')).toBeNull();
    expect(parseReleaseTag('')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('compares number by number, not as text', () => {
    expect(isNewerVersion('1.0.2', '1.0.10')).toBe(true);
    expect(isNewerVersion('1.0.10', '1.0.2')).toBe(false);
    expect(isNewerVersion('1.99.99', '2.0.0')).toBe(true);
  });

  it('is quiet about equal, older and unparseable versions', () => {
    expect(isNewerVersion('1.0.2', '1.0.2')).toBe(false);
    expect(isNewerVersion('1.0.2', '1.0.1')).toBe(false);
    expect(isNewerVersion('1.0.2', 'oops')).toBe(false);
  });

  it('tolerates a local version with fewer parts', () => {
    expect(isNewerVersion('1.0', '1.0.1')).toBe(true);
  });
});

describe('interpretRelease', () => {
  const at = 1_800_000_000_000;
  const page = 'https://github.com/o/r/releases/tag/v1.1.0';

  it('reports a newer release together with the page to open', () => {
    expect(interpretRelease({ tag_name: 'v1.1.0', html_url: page }, '1.0.2', at)).toEqual({
      at,
      state: 'available',
      version: '1.1.0',
      url: page,
    });
  });

  it('reports up to date when the release is the same version or older', () => {
    expect(interpretRelease({ tag_name: 'v1.0.2', html_url: page }, '1.0.2', at)).toEqual({
      at,
      state: 'latest',
      version: '1.0.2',
    });
    expect(interpretRelease({ tag_name: 'v0.9.0', html_url: page }, '1.0.2', at).state).toBe(
      'latest',
    );
  });

  it('fails with a reason instead of inventing a version', () => {
    expect(interpretRelease({}, '1.0.2', at).state).toBe('failed');
    expect(interpretRelease({ tag_name: 'nightly' }, '1.0.2', at)).toEqual({
      at,
      state: 'failed',
      reason: expect.any(String),
    });
  });

  it('will not offer to open a non-https or missing url', () => {
    const r = interpretRelease({ tag_name: 'v9.9.9', html_url: 'http://evil/1' }, '1.0.2', at);
    expect(r.state).toBe('failed');
  });
});

describe('updateApiUrl', () => {
  it('uses the GitHub API when no mirror is configured', () => {
    expect(updateApiUrl('')).toBe(
      'https://api.github.com/repos/lakaka2970/MeetingAssistant-main/releases/latest',
    );
  });

  it('accepts a mirror base and normalises its trailing slash', () => {
    expect(updateApiUrl('https://ghproxy.example.com/https://api.github.com/')).toBe(
      'https://ghproxy.example.com/https://api.github.com/repos/lakaka2970/MeetingAssistant-main/releases/latest',
    );
  });

  it('refuses a mirror that would leak the request over plaintext http', () => {
    expect(updateApiUrl('http://api.github.com')).toBe('');
  });
});

describe('shouldAutoCheck', () => {
  const now = 1_800_000_000_000;

  it('never fires when the user did not opt in', () => {
    expect(shouldAutoCheck({ enabled: false, now, lastAt: null })).toBe(false);
  });

  it('fires on a first run with no history', () => {
    expect(shouldAutoCheck({ enabled: true, now, lastAt: null })).toBe(true);
  });

  it('waits out the interval after any outcome, including a failure', () => {
    expect(shouldAutoCheck({ enabled: true, now, lastAt: now - 3600_000 })).toBe(false);
    expect(
      shouldAutoCheck({ enabled: true, now, lastAt: now - UPDATE_CHECK_INTERVAL_MS - 1 }),
    ).toBe(true);
  });

  it('does not re-run for a stamp in the future (clock moved back)', () => {
    expect(shouldAutoCheck({ enabled: true, now, lastAt: now + 10_000 })).toBe(false);
  });
});
