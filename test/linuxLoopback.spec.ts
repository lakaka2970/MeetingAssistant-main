import { describe, expect, it } from 'vitest';
import type { LoopbackSink } from '../shared/protocol';
import {
  channelOf,
  F32StreamDecoder,
  isStaleFrame,
  isTappedAt,
  LOOPBACK_JUNK_WINDOW_SAMPLES,
  parseLinkPairs,
  parsePwDumpSinks,
  parseWpctlDefaultSink,
  planMonitorRewire,
  portsOf,
  pickLoopbackSink,
  pwRecordArgs,
  trimSettlingFrames,
} from '../electron/audio/linuxLoopback';

/** pw-dump shape, trimmed to the properties the parser reads (captured on PipeWire 1.0.5) */
const PW_DUMP = JSON.stringify([
  {
    id: 32,
    info: { props: { 'media.class': 'Client' } },
  },
  {
    id: 56,
    info: {
      props: {
        'media.class': 'Audio/Sink',
        'node.name': 'alsa_output.pci-0000_65_00.6.analog-stereo',
        'node.description': 'Family 17h/19h HD Audio Controller Analog Stereo',
      },
    },
  },
  {
    id: 57,
    info: {
      props: {
        'media.class': 'Audio/Source',
        'node.name': 'alsa_input.pci-0000_65_00.6.analog-stereo',
        'node.description': 'Family 17h/19h HD Audio Controller Analog Stereo',
      },
    },
  },
  {
    id: 90,
    info: {
      props: {
        'media.class': 'Audio/Sink',
        'node.name': 'alsa_output.pci-0000_00_1f.3.hdmi-stereo',
        'node.nick': 'HDMI / DisplayPort',
      },
    },
  },
]);

const SINKS: LoopbackSink[] = [
  { id: '56', name: 'alsa_output.pci-0000_65_00.6.analog-stereo', description: 'Speakers' },
  { id: '90', name: 'alsa_output.pci-0000_00_1f.3.hdmi-stereo', description: 'HDMI' },
];

const WPCTL_STATUS = `Audio
 ├─ Devices:
 │      50. alsa_card.pci-0000_65_00.6          [alsa]
 │
 ├─ Sinks:
 │  *   56. alsa_output.pci-0000_65_00.6.analog-stereo [vol: 0.40]
 │      90. alsa_output.pci-0000_00_1f.3.hdmi-stereo [vol: 0.60]
 │
 ├─ Sink endpoints:
 │
 ├─ Sources:
 │  *   57. alsa_input.pci-0000_65_00.6.analog-stereo [vol: 1.00]
`;

describe('linuxLoopback sink discovery', () => {
  it('reads only Audio/Sink nodes out of a pw-dump document', () => {
    const sinks = parsePwDumpSinks(PW_DUMP);
    expect(sinks).toEqual([
      {
        id: '56',
        name: 'alsa_output.pci-0000_65_00.6.analog-stereo',
        description: 'Family 17h/19h HD Audio Controller Analog Stereo',
      },
      { id: '90', name: 'alsa_output.pci-0000_00_1f.3.hdmi-stereo', description: 'HDMI / DisplayPort' },
    ]);
  });

  it('joins every top-level document pw-dump prints, not just the first', () => {
    // measured on PipeWire 1.0.5: the graph array, then a second array for an
    // object that registered mid-dump
    const two = `${PW_DUMP}\n[{"id": 99, "info": {"props": {"media.class": "Audio/Sink", "node.name": "alsa_output.hdmi", "node.nick": "HDMI"}}}]\n`;
    expect(parsePwDumpSinks(two)).toHaveLength(3);
    expect(parsePwDumpSinks(two)[2].name).toBe('alsa_output.hdmi');
  });

  it('is not confused by brackets or quotes inside node descriptions', () => {
    const tricky = JSON.stringify([
      {
        id: 7,
        info: {
          props: {
            'media.class': 'Audio/Sink',
            'node.name': 'alsa_output.x',
            'node.description': 'Speakers [built-in] "array" ]',
          },
        },
      },
    ]);
    expect(parsePwDumpSinks(tricky)).toEqual([
      { id: '7', name: 'alsa_output.x', description: 'Speakers [built-in] "array" ]' },
    ]);
  });

  it('shrugs at garbage instead of throwing (a killed pw-dump prints a partial file)', () => {
    expect(parsePwDumpSinks('')).toEqual([]);
    expect(parsePwDumpSinks('[{oops')).toEqual([]);
    expect(parsePwDumpSinks('{"not":"an array"}')).toEqual([]);
  });

  it('takes the starred sink out of the Sinks section only', () => {
    expect(parseWpctlDefaultSink(WPCTL_STATUS)).toEqual({
      id: '56',
      name: 'alsa_output.pci-0000_65_00.6.analog-stereo',
    });
    expect(parseWpctlDefaultSink('Audio\n ├─ Streams:\n')).toBeNull();
  });

  it('prefers the user pick, then PipeWire default, then the only sink there is', () => {
    expect(pickLoopbackSink(SINKS, 'alsa_output.pci-0000_00_1f.3.hdmi-stereo', '56')?.id).toBe('90');
    expect(pickLoopbackSink(SINKS, 'gone.device', '90')?.id).toBe('90');
    expect(pickLoopbackSink([SINKS[1]], undefined, null)?.id).toBe('90');
    expect(pickLoopbackSink(SINKS, undefined, '90')?.id).toBe('90');
    // two sinks and no stated default: guessing would silently tap the one
    // nothing is playing into, which reads as "nobody is speaking"
    expect(pickLoopbackSink(SINKS, undefined, null)).toBeNull();
    expect(pickLoopbackSink([], undefined, '56')).toBeNull();
  });

  it('names a --target and a node.name, because pw-record otherwise records the microphone', () => {
    expect(pwRecordArgs('alsa_output.x', 'ma-loop-42')).toEqual([
      '--target',
      'alsa_output.x',
      '--rate',
      '16000',
      '--channels',
      '1',
      '--format',
      'f32',
      '--properties',
      'node.name=ma-loop-42',
      '-',
    ]);
  });
});

describe('stale leading frames', () => {
  const frame = (v: number, n = 1024) => new Float32Array(n).fill(v);

  it('rejects anything that cannot be real audio', () => {
    expect(isStaleFrame(frame(0.2))).toBe(false);
    expect(isStaleFrame(frame(1))).toBe(false); // full scale is legitimate
    expect(isStaleFrame(frame(-1))).toBe(false);
    expect(isStaleFrame(frame(1.09))).toBe(true); // the measured ring-buffer junk
    expect(isStaleFrame(frame(-2))).toBe(true);
    expect(isStaleFrame(new Float32Array([0.1, Number.NaN]))).toBe(true);
  });

  it('drops the first frame outright, then only out-of-range frames', () => {
    const first = trimSettlingFrames(frame(0.9), 0);
    expect(first.out.length).toBe(0); // < MIN_SETTLE regardless of content
    expect(first.seen).toBe(1024);

    const second = trimSettlingFrames(frame(0.9), first.seen);
    expect(second.out.length).toBe(1024); // in range → through, ~64 ms after ▶
    expect(second.seen).toBe(2048);

    const junk = trimSettlingFrames(frame(1.4), second.seen);
    expect(junk.out.length).toBe(0);
  });

  it('stops filtering once the junk window closes', () => {
    const late = trimSettlingFrames(frame(1.4), LOOPBACK_JUNK_WINDOW_SAMPLES);
    expect(late.out.length).toBe(1024); // sustained loud audio is never dropped
    expect(late.seen).toBe(LOOPBACK_JUNK_WINDOW_SAMPLES);
  });

  it('lets the whole window pass if every frame is in range', () => {
    let seen = 0;
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const r = trimSettlingFrames(frame(0.3), seen);
      seen = r.seen;
      accepted += r.out.length;
    }
    // 40 frames × 1024 = 1 second: one dropped, the rest through
    expect(accepted).toBe(39 * 1024);
  });
});

describe('monitor rewire', () => {
  /** real `pw-link --links` output: a browser playing out, our stream hijacked by the mic */
  const LINKS = `alsa_output.pci-0000_65_00.6.analog-stereo:playback_FL
  |<- Microsoft Edge:output_FL
alsa_input.pci-0000_65_00.6.analog-stereo:capture_FL
  |-> ma-loop-42:input_FL
alsa_input.pci-0000_65_00.6.analog-stereo:capture_FR
  |-> ma-loop-42:input_FR
ma-loop-42:input_FL
  |<- alsa_input.pci-0000_65_00.6.analog-stereo:capture_FL
`;

  it('reads each link once, in output→input direction', () => {
    const pairs = parseLinkPairs(LINKS);
    expect(pairs).toEqual([
      { output: 'Microsoft Edge:output_FL', input: 'alsa_output.pci-0000_65_00.6.analog-stereo:playback_FL' },
      { output: 'alsa_input.pci-0000_65_00.6.analog-stereo:capture_FL', input: 'ma-loop-42:input_FL' },
      { output: 'alsa_input.pci-0000_65_00.6.analog-stereo:capture_FR', input: 'ma-loop-42:input_FR' },
    ]);
  });

  it('finds our ports and their channels', () => {
    const listed = 'alsa_output.x:playback_FL\nma-loop-42:input_FL\nma-loop-42:input_FR\n';
    expect(portsOf(listed, 'ma-loop-42')).toEqual(['ma-loop-42:input_FL', 'ma-loop-42:input_FR']);
    expect(channelOf('ma-loop-42:input_FL')).toBe('FL');
    expect(channelOf('alsa_output.x:monitor_FR')).toBe('FR');
  });

  it('tears the mic links down and replaces them with the matching monitor channels', () => {
    const plan = planMonitorRewire(
      ['ma-loop-42:input_FL', 'ma-loop-42:input_FR'],
      parseLinkPairs(LINKS),
      ['alsa_output.pci-0000_65_00.6.analog-stereo:monitor_FL', 'alsa_output.pci-0000_65_00.6.analog-stereo:monitor_FR'],
    );
    expect(plan.disconnect.map((l) => l.output)).toEqual([
      'alsa_input.pci-0000_65_00.6.analog-stereo:capture_FL',
      'alsa_input.pci-0000_65_00.6.analog-stereo:capture_FR',
    ]);
    expect(plan.connect).toEqual([
      { output: 'alsa_output.pci-0000_65_00.6.analog-stereo:monitor_FL', input: 'ma-loop-42:input_FL' },
      { output: 'alsa_output.pci-0000_65_00.6.analog-stereo:monitor_FR', input: 'ma-loop-42:input_FR' },
    ]);
    expect(plan.unmatched).toEqual([]);
  });

  it('leaves an already-correct monitor link alone', () => {
    const plan = planMonitorRewire(
      ['ma-loop-42:input_FL'],
      [{ output: 'alsa_output.x:monitor_FL', input: 'ma-loop-42:input_FL' }],
      ['alsa_output.x:monitor_FL'],
    );
    expect(plan.connect).toEqual([]);
    // disconnecting this would be the bug: nothing re-establishes it
    expect(plan.disconnect).toEqual([]);
  });

  it('routes everything to the one monitor a mono sink exposes', () => {
    const plan = planMonitorRewire(
      ['ma-loop-42:input_FL', 'ma-loop-42:input_FR'],
      parseLinkPairs(LINKS),
      ['alsa_output.pci-0000_65_00.6.analog-stereo:monitor_FL'],
    );
    expect(plan.unmatched).toEqual([]);
    expect(plan.connect.map((c) => c.input)).toEqual(['ma-loop-42:input_FL', 'ma-loop-42:input_FR']);
    expect(plan.connect.every((c) => c.output.endsWith(':monitor_FL'))).toBe(true);
  });

  it('reports a port it could not match instead of quietly leaving the mic connected', () => {
    const plan = planMonitorRewire(['ma-loop-42:input_FL'], parseLinkPairs(LINKS), []);
    expect(plan.unmatched).toEqual(['ma-loop-42:input_FL']);
    expect(plan.connect).toEqual([]);
  });

  it('only calls a capture "system audio" once every port really reads the monitor', () => {
    const sink = 'alsa_output.pci-0000_65_00.6.analog-stereo';
    const ports = ['ma-loop-42:input_FL', 'ma-loop-42:input_FR'];
    expect(isTappedAt(ports, parseLinkPairs(LINKS), sink)).toBe(false);
    expect(
      isTappedAt(
        ports,
        [
          { output: `${sink}:monitor_FL`, input: ports[0] },
          { output: `${sink}:monitor_FR`, input: ports[1] },
        ],
        sink,
      ),
    ).toBe(true);
    // one port still on the mic is enough to make the claim false
    expect(isTappedAt(ports, [{ output: `${sink}:monitor_FL`, input: ports[0] }], sink)).toBe(false);
    expect(isTappedAt([], [], sink)).toBe(false);
  });
});

describe('F32StreamDecoder', () => {
  const f32 = (values: number[]): Buffer => {
    const buf = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
    return buf;
  };

  it('decodes the bare float32 stream pw-record actually writes to stdout', () => {
    const d = new F32StreamDecoder();
    expect(Array.from(d.push(f32([0.25, -0.5, 1.0])) ?? [])).toEqual([0.25, -0.5, 1.0]);
    expect(d.started).toBe(true);
  });

  it('carries a split sample into the next chunk instead of truncating it', () => {
    const d = new F32StreamDecoder();
    const whole = f32([0.5, 0.25]);
    const first = d.push(whole.subarray(0, 6));
    const second = d.push(whole.subarray(6));
    expect(Array.from(first ?? [])).toEqual([0.5]);
    expect(Array.from(second ?? [])).toEqual([0.25]);
  });

  it('skips a RIFF container when a version prefixes one', () => {
    const header = Buffer.alloc(12);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    const fmt = Buffer.alloc(8 + 16);
    fmt.write('fmt ', 0);
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(3 /* IEEE float */, 8 + 2);
    fmt.writeUInt32LE(16000, 8 + 4);
    const data = Buffer.alloc(8);
    data.write('data', 0);
    data.writeUInt32LE(8, 4);
    const d = new F32StreamDecoder();
    const payload = f32([0.125, -0.125]);
    expect(Array.from(d.push(Buffer.concat([header, fmt, data, payload])) ?? [])).toEqual([
      0.125, -0.125,
    ]);
  });

  it('waits for a header that straddles reads, losing nothing', () => {
    const header = Buffer.alloc(12);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0);
    fmt.writeUInt32LE(16, 4);
    const dataHdr = Buffer.alloc(8);
    dataHdr.write('data', 0);
    dataHdr.writeUInt32LE(4, 4);
    const d = new F32StreamDecoder();
    // chunk 1 ends mid-fmt, chunk 2 completes the header plus one sample
    expect(d.push(Buffer.concat([header, fmt.subarray(0, 10)]))).toBeNull();
    expect(d.started).toBe(false);
    const rest = Buffer.concat([fmt.subarray(10), dataHdr, f32([0.75])]);
    expect(Array.from(d.push(rest) ?? [])).toEqual([0.75]);
    expect(d.started).toBe(true);
  });
});
