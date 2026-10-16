import { readFileSync, existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  detectFromBytes,
  parseTsPmtFlags,
  resolveAmbiguousFlags,
  scanAnnexBNalHits,
} from './stream-codec';

function makeTs(fill: (packet: number, i: number) => number = () => 0): Uint8Array {
  const buf = new Uint8Array(188 * 4);
  for (let p = 0; p < 4; p++) {
    buf[p * 188] = 0x47;
    for (let i = 1; i < 188; i++) buf[p * 188 + i] = fill(p, i);
  }
  return buf;
}

describe('resolveAmbiguousFlags', () => {
  it('双命中时偏 H.264，避免假 HEVC 信号主导', () => {
    expect(resolveAmbiguousFlags({ has264: true, has265: true, hasAv1: false })).toEqual({
      has264: true,
      has265: false,
      hasAv1: false,
    });
  });
});

describe('detectFromBytes 合成样本', () => {
  it('真 H.264 NAL + 松散窗口里的 0x24 不应再被判成纯 H.265', () => {
    const buf = makeTs();
    // 旧逻辑会把「疑似 PMT 后 400 字节内的 0x24」当成 HEVC
    buf[10] = 0x02;
    buf[11] = 0xb0;
    buf[30] = 0x1b;
    buf[40] = 0x24;
    buf[50] = 0;
    buf[51] = 0;
    buf[52] = 0;
    buf[53] = 1;
    buf[54] = 0x67;
    buf[55] = 0;
    buf[56] = 0;
    buf[57] = 0;
    buf[58] = 1;
    buf[59] = 0x68;
    const r = detectFromBytes(buf);
    expect(r.has264).toBe(true);
    expect(r.has265).toBe(false);
  });

  it('H.264 SPS/PPS + 假 start code 0x40 不应判成 H.265', () => {
    const buf = makeTs();
    buf[50] = 0;
    buf[51] = 0;
    buf[52] = 0;
    buf[53] = 1;
    buf[54] = 0x67;
    buf[55] = 0;
    buf[56] = 0;
    buf[57] = 0;
    buf[58] = 1;
    buf[59] = 0x68;
    buf[80] = 0;
    buf[81] = 0;
    buf[82] = 1;
    buf[83] = 0x40; // 看起来像 HEVC VPS，但无合法第二字节 / 无 SPS
    buf[84] = 0xff;
    const r = detectFromBytes(buf);
    expect(r.has264).toBe(true);
    expect(r.has265).toBe(false);
  });

  it('合法 HEVC VPS+SPS 头应判成 H.265', () => {
    const buf = makeTs();
    // VPS: type 32 → 0x40, layer_id=0, tid=1 → 第二字节 0x01
    buf[50] = 0;
    buf[51] = 0;
    buf[52] = 1;
    buf[53] = 0x40;
    buf[54] = 0x01;
    // SPS type 33 → 0x42
    buf[55] = 0;
    buf[56] = 0;
    buf[57] = 1;
    buf[58] = 0x42;
    buf[59] = 0x01;
    const r = detectFromBytes(buf);
    expect(r.has265).toBe(true);
    expect(r.has264).toBe(false);
  });

  it('结构化 PMT stream_type=0x1b 判 H.264', () => {
    // 手工拼一个极简 PMT：在第一个 packet payload 里
    const buf = makeTs();
    // payload_unit_start=1, afc=1 (payload only): byte1 = 0x40, byte3 = 0x10
    buf[1] = 0x40;
    buf[3] = 0x10;
    buf[4] = 0x00; // pointer_field
    const p = 5;
    buf[p] = 0x02; // PMT
    buf[p + 1] = 0xb0;
    buf[p + 2] = 0x17; // section_length：覆盖 stream 描述 + CRC 占位
    buf[p + 10] = 0x00;
    buf[p + 11] = 0x00; // program_info_length
    buf[p + 12] = 0x1b; // AVC
    buf[p + 13] = 0xe0;
    buf[p + 14] = 0x01; // elementary_PID
    buf[p + 15] = 0x00;
    buf[p + 16] = 0x00; // ES_info_length
    const pmt = parseTsPmtFlags(buf);
    expect(pmt.has264).toBe(true);
    expect(pmt.has265).toBe(false);
    expect(detectFromBytes(buf).has264).toBe(true);
  });
});

describe('真实 / 生成分片（有文件才跑）', () => {
  const samples: Array<{ path: string; expect265: boolean }> = [
    { path: '/tmp/bfzy.ts', expect265: false },
    { path: '/tmp/ffzy.ts', expect265: false },
    { path: '/tmp/h264_gen.ts', expect265: false },
    { path: '/tmp/h265_gen.ts', expect265: true },
  ];

  for (const s of samples) {
    it.skipIf(!existsSync(s.path))(`${s.path} → ${s.expect265 ? 'H.265' : 'H.264'}`, () => {
      const buf = new Uint8Array(readFileSync(s.path));
      const r = detectFromBytes(buf);
      if (s.expect265) {
        expect(r.has265).toBe(true);
        expect(r.has264).toBe(false);
      } else {
        expect(r.has264).toBe(true);
        expect(r.has265).toBe(false);
      }
      // 真 H.264 分片里常有大量「假 HEVC VPS」字节，但严格头后应变少
      if (!s.expect265) {
        const hits = scanAnnexBNalHits(buf);
        expect(hits.avcSps).toBeGreaterThan(0);
      }
    });
  }
});
