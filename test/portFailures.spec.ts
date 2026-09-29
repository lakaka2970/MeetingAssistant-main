/**
 * Why a listener or a local engine failed to start.
 *
 * Both of these used to report one generic reason for several different
 * failures, and on a machine with Hyper-V/WSL/VMware the two most common causes
 * are NOT "something is using the port": Windows reserves whole port ranges for
 * the hypervisor, and a bind inside that range fails with EACCES no matter what
 * the user kills. A user who is told "端口被占用" will close apps forever and
 * still not get through, so the reason has to be the one that is actually true.
 */
import { describe, expect, it } from 'vitest';
import { describeBindFailures } from '../electron/companion/server';
import { describeSidecarExit } from '../electron/funasrSidecar';

describe('companion bind failures', () => {
  it('names the reserved range when every attempt hit EACCES', () => {
    const attempts = [
      { port: 18765, code: 'EACCES' },
      { port: 18766, code: 'EACCES' },
    ];
    const msg = describeBindFailures(attempts);
    expect(msg).toContain('18765');
    expect(msg).toContain('18766');
    expect(msg).toContain('保留');
    expect(msg).toContain('端口');
    // "被占用" sends the user to close programs; the fix is a different port
    expect(msg).not.toContain('占用');
  });

  it('says occupied when every attempt hit EADDRINUSE', () => {
    const msg = describeBindFailures([
      { port: 18765, code: 'EADDRINUSE' },
      { port: 18766, code: 'EADDRINUSE' },
    ]);
    expect(msg).toContain('占用');
    expect(msg).not.toContain('保留');
  });

  it('reports both codes when the walk saw a mix', () => {
    const msg = describeBindFailures([
      { port: 18765, code: 'EACCES' },
      { port: 18766, code: 'EADDRINUSE' },
    ]);
    expect(msg).toContain('EACCES');
    expect(msg).toContain('EADDRINUSE');
  });

  it('never loses an unknown code', () => {
    const msg = describeBindFailures([{ port: 18765, code: 'EPERM' }]);
    expect(msg).toContain('EPERM');
  });

  it('handles an attempt with no code at all', () => {
    expect(describeBindFailures([{ port: 18765 }])).toContain('18765');
  });
});

describe('local ASR sidecar exit', () => {
  const base = { port: 10097, envName: 'funasr' };

  it('blames the port when python could not bind', () => {
    const msg = describeSidecarExit({
      ...base,
      code: 1,
      stderr: 'OSError: [Errno 10048] error while attempting to bind on address (\'127.0.0.1\', 10097): only one usage of each socket address',
    });
    expect(msg).toContain('10097');
    expect(msg).not.toContain('conda');
  });

  it('keeps the env hint when python itself failed to import', () => {
    const msg = describeSidecarExit({
      ...base,
      code: 1,
      stderr: 'ModuleNotFoundError: No module named \'funasr\'',
    });
    expect(msg).toContain('funasr');
    expect(msg).toContain('conda');
  });

  it('carries the real last line when nothing matched', () => {
    const msg = describeSidecarExit({ ...base, code: 3, stderr: 'some engine detail\nlast line here' });
    expect(msg).toContain('last line here');
    expect(msg).toContain('code 3');
  });

  it('still explains a silent exit', () => {
    const msg = describeSidecarExit({ ...base, code: null, stderr: '' });
    expect(msg).toContain('conda');
    expect(msg).toContain('code null');
  });
});
