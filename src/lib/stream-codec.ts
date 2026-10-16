/**
 * 从 HLS 清单 / 分片探测视频编码（H.264 / H.265），供播放页投屏提示使用。
 * 清单拉取统一走 /api/proxy，规避上游 CORS。
 */

import { PROXY_BASE } from '@/lib/m3u8';

export type CodecKind = 'h264' | 'h265' | 'mixed' | 'av1' | 'unknown' | 'detecting';

export interface CodecFlags {
  has264: boolean;
  has265: boolean;
  hasAv1: boolean;
}

export interface CodecInfo {
  kind: CodecKind;
  label: string;
  hint: string;
}

export function emptyFlags(): CodecFlags {
  return { has264: false, has265: false, hasAv1: false };
}

export function hasAnyCodec(c: CodecFlags): boolean {
  return c.has264 || c.has265 || c.hasAv1;
}

export function mergeFlags(a: CodecFlags, b: CodecFlags): CodecFlags {
  return {
    has264: a.has264 || b.has264,
    has265: a.has265 || b.has265,
    hasAv1: a.hasAv1 || b.hasAv1,
  };
}

export function classifyCodecText(text: string): CodecFlags {
  return {
    has264: /(?:^|[",;\s/|])avc[1-4]/i.test(text) || /\bh264\b/i.test(text),
    has265: /(?:^|[",;\s/|])(?:hvc1|hev1|dvh1|dvhe)/i.test(text) || /\bhevc\b/i.test(text),
    hasAv1: /(?:^|[",;\s/|])av01/i.test(text),
  };
}

/** 混编且已自动避开 H.265 */
export function preferredH264Info(): CodecInfo {
  return {
    kind: 'h264',
    label: '可投屏（已避开 H.265）',
    hint: '源编码：H.264 / H.265（混编）。目前编码：H.264（已自动改用，方便 AirPlay 出画）。',
  };
}

export function toCodecInfo(c: CodecFlags): CodecInfo {
  // 只要有 H.264 可选，就按「已优先 H.264」展示（播放器侧会真正锁到 H.264 档）
  if (c.has264 && c.has265) return preferredH264Info();
  if (c.has265) {
    return {
      kind: 'h265',
      label: '投屏可能无画面',
      hint: '源编码：H.265。目前编码：H.265。本机可正常观看；用 AirPlay 投到 Apple TV 时，常常只有声音没有画面。',
    };
  }
  if (c.has264) {
    return {
      kind: 'h264',
      label: '可投屏',
      hint: '源编码：H.264。目前编码：H.264。AirPlay 投到 Apple TV 一般能正常出画。',
    };
  }
  if (c.hasAv1) {
    return {
      kind: 'av1',
      label: '投屏可能异常',
      hint: '源编码：AV1。目前编码：AV1。AirPlay 兼容性较差，建议换源后再投屏。',
    };
  }
  return {
    kind: 'unknown',
    label: '编码未识别',
    hint: '源编码 / 目前编码均未识别。不影响本机播放。若投屏只有声音，多半是 H.265，可换源再试。',
  };
}

/** 在 levels 里找码率最高的 H.264 档，找不到返回 -1 */
export function findBestH264LevelIndex(
  levels: Array<{ videoCodec?: string; bitrate?: number }>
): number {
  let best = -1;
  let bestBr = -1;
  for (let i = 0; i < levels.length; i++) {
    const codec = levels[i]?.videoCodec || '';
    if (!/avc[1-4]/i.test(codec)) continue;
    const br = levels[i]?.bitrate ?? 0;
    if (br >= bestBr) {
      bestBr = br;
      best = i;
    }
  }
  return best;
}

export function levelListHasHevc(levels: Array<{ videoCodec?: string }>): boolean {
  return levels.some((l) => /hvc1|hev1|dvh1|dvhe/i.test(l.videoCodec || ''));
}

export function levelListHasCodecLabels(levels: Array<{ videoCodec?: string }>): boolean {
  return levels.some((l) => !!l.videoCodec);
}

/**
 * 单段同时命中时的收敛：优先相信更干净的信号。
 * 旧逻辑一律偏 H.265，会把「真 H.264 + 松散 PMT/假 start code」误判成纯 H.265。
 */
export function resolveAmbiguousFlags(flags: CodecFlags): CodecFlags {
  if (!(flags.has264 && flags.has265)) return flags;
  // 单 ES 分片不可能真混编；Ambiguous 时偏 H.264（投屏更稳，且与假 HEVC 信号更吻合）
  return { has264: true, has265: false, hasAv1: flags.hasAv1 };
}

function proxyUrl(url: string): string {
  if (url.startsWith('/api/proxy') || url.startsWith('/api/live/stream')) return url;
  return PROXY_BASE + encodeURIComponent(url);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<{ finalUrl: string; text: string }> {
  const res = await fetch(proxyUrl(url), { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { finalUrl: res.url || url, text: await res.text() };
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(proxyUrl(url), {
    credentials: 'same-origin',
    signal,
    headers: { Range: 'bytes=0-262143' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function findFourCC(u8: Uint8Array, ascii: string): boolean {
  const a = ascii.charCodeAt(0);
  const b = ascii.charCodeAt(1);
  const c = ascii.charCodeAt(2);
  const d = ascii.charCodeAt(3);
  for (let i = 0; i < u8.length - 3; i++) {
    if (u8[i] === a && u8[i + 1] === b && u8[i + 2] === c && u8[i + 3] === d) return true;
  }
  return false;
}

/** 在 MPEG-TS 中找 188 字节对齐的 sync 起点 */
function findTsSync(buf: Uint8Array): number {
  for (let s = 0; s < Math.min(buf.length, 188); s++) {
    if (buf[s] === 0x47 && s + 188 < buf.length && buf[s + 188] === 0x47) return s;
  }
  return -1;
}

/**
 * 按 PMT 表结构读 stream_type（0x1B=AVC, 0x24=HEVC）。
 * 旧实现在「疑似 PMT 头」后 400 字节内盲扫 0x24，极易误触。
 */
export function parseTsPmtFlags(buf: Uint8Array): CodecFlags {
  const out = emptyFlags();
  const sync = findTsSync(buf);
  if (sync < 0) return out;

  for (let off = sync; off + 188 <= buf.length; off += 188) {
    if (buf[off] !== 0x47) continue;
    const payloadUnitStart = (buf[off + 1] & 0x40) !== 0;
    const afc = (buf[off + 3] >> 4) & 0x3;
    let p = off + 4;
    if (afc === 2 || afc === 3) {
      if (p >= off + 188) continue;
      p += 1 + buf[p];
    }
    if (afc === 0 || p >= off + 188) continue;
    if (payloadUnitStart) {
      if (p >= off + 188) continue;
      p += 1 + buf[p];
    }
    if (p + 12 >= off + 188) continue;
    if (buf[p] !== 0x02) continue; // table_id = PMT

    const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const programInfoLength = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
    let q = p + 12 + programInfoLength;
    const end = Math.min(p + 3 + sectionLength - 4, off + 188);
    while (q + 5 <= end) {
      const streamType = buf[q];
      const esInfoLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
      if (streamType === 0x1b || streamType === 0x20 || streamType === 0x27) out.has264 = true;
      if (streamType === 0x24 || streamType === 0x25) out.has265 = true;
      q += 5 + esInfoLen;
    }
  }
  return out;
}

interface NalCodecHits {
  avcSps: number;
  avcPps: number;
  hevcVps: number;
  hevcSps: number;
  hevcPps: number;
}

/** HEVC NAL 头需 layer_id=0 且 temporal_id_plus1>=1，过滤码流里的假 start code */
function hevcNalHeaderOk(buf: Uint8Array, nalPos: number, firstByte: number): boolean {
  if (nalPos + 1 >= buf.length) return false;
  const b1 = buf[nalPos + 1];
  const layerId = ((firstByte & 1) << 5) | (b1 >> 3);
  const tidPlus1 = b1 & 0x07;
  return layerId === 0 && tidPlus1 >= 1;
}

export function scanAnnexBNalHits(buf: Uint8Array): NalCodecHits {
  const hits: NalCodecHits = { avcSps: 0, avcPps: 0, hevcVps: 0, hevcSps: 0, hevcPps: 0 };
  for (let k = 0; k < buf.length - 5; k++) {
    let nalPos = -1;
    if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 1) nalPos = k + 3;
    else if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 0 && buf[k + 3] === 1) nalPos = k + 4;
    if (nalPos < 0 || nalPos >= buf.length) continue;
    const nb = buf[nalPos];

    const hevcType = (nb >> 1) & 0x3f;
    if ((hevcType === 32 || hevcType === 33 || hevcType === 34) && hevcNalHeaderOk(buf, nalPos, nb)) {
      if (hevcType === 32) hits.hevcVps++;
      else if (hevcType === 33) hits.hevcSps++;
      else hits.hevcPps++;
    }

    const avcType = nb & 0x1f;
    if ((nb & 0x80) === 0 && avcType === 7) hits.avcSps++;
    if ((nb & 0x80) === 0 && avcType === 8) hits.avcPps++;
  }
  return hits;
}

function flagsFromNalHits(hits: NalCodecHits): CodecFlags {
  const out = emptyFlags();
  // 真 HEVC 分片通常能扫到 VPS，并伴随 SPS/PPS；单凭零散「像 VPS」的假 start code 不够
  const strongHevc = hits.hevcVps >= 1 && (hits.hevcSps >= 1 || hits.hevcPps >= 1);
  const weakHevc = hits.hevcVps >= 1;
  const avc = hits.avcSps >= 1;

  if (strongHevc && !avc) {
    out.has265 = true;
    return out;
  }
  if (avc && !strongHevc) {
    out.has264 = true;
    return out;
  }
  if (strongHevc && avc) {
    // 单段双信号：SPS/PPS 对 AVC 更稳；强 HEVC 同时出现时仍标 265（少见）
    out.has265 = true;
    return out;
  }
  if (weakHevc) out.has265 = true;
  else if (hits.avcPps >= 1) out.has264 = true;
  return out;
}

export function detectFromBytes(buf: Uint8Array): CodecFlags {
  const out = emptyFlags();
  if (buf.length < 16) return out;

  if (findFourCC(buf, 'hvc1') || findFourCC(buf, 'hev1') || findFourCC(buf, 'hvcC') || findFourCC(buf, 'dvh1') || findFourCC(buf, 'dvhe')) {
    out.has265 = true;
  }
  if (findFourCC(buf, 'avc1') || findFourCC(buf, 'avc3') || findFourCC(buf, 'avcC')) {
    out.has264 = true;
  }
  if (findFourCC(buf, 'av01') || findFourCC(buf, 'av1C')) {
    out.hasAv1 = true;
  }
  if (hasAnyCodec(out)) return out;

  if (findTsSync(buf) < 0) return out;

  // 1) 结构化 PMT（高置信）
  const pmt = parseTsPmtFlags(buf);
  if (pmt.has264 && !pmt.has265) return pmt;
  if (pmt.has265 && !pmt.has264) return pmt;

  // 2) Annex-B NAL（收紧 HEVC 头校验）
  const nal = flagsFromNalHits(scanAnnexBNalHits(buf));
  if (hasAnyCodec(nal)) return nal;

  // 3) PMT 双命中等残局
  if (hasAnyCodec(pmt)) return resolveAmbiguousFlags(pmt);
  return out;
}

function parseMasterChildren(text: string): { flags: CodecFlags; childUrls: string[] } {
  const lines = text.split(/\r?\n/);
  let pending: string | null = null;
  const childUrls: string[] = [];
  let flags = emptyFlags();
  let isMaster = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = line;
      isMaster = true;
      continue;
    }
    if (pending && !line.startsWith('#')) {
      const codecsMatch = /CODECS="([^"]+)"/i.exec(pending);
      flags = mergeFlags(flags, classifyCodecText(codecsMatch?.[1] || pending));
      childUrls.push(line);
      pending = null;
    }
  }

  return { flags: isMaster ? flags : emptyFlags(), childUrls: isMaster ? childUrls : [] };
}

function parseMediaTargets(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const targets: string[] = [];
  let firstSeg: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const mapMatch = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/i.exec(line);
    if (mapMatch) targets.push(mapMatch[1]);
    if (line.startsWith('#')) continue;
    if (!firstSeg) firstSeg = line;
  }
  if (firstSeg) targets.push(firstSeg);
  return targets;
}

/** 探测单个 media / master 子清单的编码（不含「跨变体合并」） */
export async function detectPlaylistFlags(url: string, signal?: AbortSignal): Promise<CodecFlags> {
  const { text } = await fetchText(url, signal);
  if (!text.includes('#EXTM3U')) return emptyFlags();

  const fromText = classifyCodecText(text);
  if (hasAnyCodec(fromText)) return fromText;

  const master = parseMasterChildren(text);
  if (hasAnyCodec(master.flags)) return master.flags;

  // media playlist：探分片；若仍是 master 无 CODECS，探第一个子清单的分片
  const mediaUrl = master.childUrls[0];
  const mediaText = mediaUrl ? (await fetchText(mediaUrl, signal)).text : text;
  const mediaFlags = classifyCodecText(mediaText);
  if (hasAnyCodec(mediaFlags)) return mediaFlags;

  for (const target of parseMediaTargets(mediaText).slice(0, 2)) {
    try {
      const bytes = await fetchBytes(target, signal);
      const segFlags = detectFromBytes(bytes);
      if (hasAnyCodec(segFlags)) return segFlags;
    } catch {
      /* continue */
    }
  }
  return emptyFlags();
}

export type LevelCodecKind = 'h264' | 'h265' | 'av1' | 'unknown';

function flagsToLevelKind(f: CodecFlags): LevelCodecKind {
  if (f.has264 && !f.has265) return 'h264';
  if (f.has265 && !f.has264) return 'h265';
  if (f.has264 && f.has265) return 'h264'; // 单档双命中时按可投屏优先
  if (f.hasAv1) return 'av1';
  return 'unknown';
}

/**
 * 对 hls.js levels 逐档探测编码（清单常不带 CODECS）。
 * 返回各档 kind，供播放器锁定 H.264。
 */
export async function classifyHlsLevels(
  levels: Array<{ url?: string | string[]; bitrate?: number }>,
  signal?: AbortSignal
): Promise<Array<{ index: number; kind: LevelCodecKind; bitrate: number }>> {
  const out: Array<{ index: number; kind: LevelCodecKind; bitrate: number }> = [];
  const limit = Math.min(levels.length, 6);
  for (let i = 0; i < limit; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const raw = levels[i]?.url;
    const url = Array.isArray(raw) ? raw[0] : raw;
    if (!url) {
      out.push({ index: i, kind: 'unknown', bitrate: levels[i]?.bitrate ?? 0 });
      continue;
    }
    try {
      const flags = await detectPlaylistFlags(url, signal);
      out.push({ index: i, kind: flagsToLevelKind(flags), bitrate: levels[i]?.bitrate ?? 0 });
    } catch {
      out.push({ index: i, kind: 'unknown', bitrate: levels[i]?.bitrate ?? 0 });
    }
  }
  return out;
}

export function pickBestH264FromClassified(
  classified: Array<{ index: number; kind: LevelCodecKind; bitrate: number }>
): { h264Indexes: number[]; best: number } | null {
  const h264Indexes = classified.filter((c) => c.kind === 'h264').map((c) => c.index);
  if (h264Indexes.length === 0) return null;
  let best = h264Indexes[0];
  let bestBr = -1;
  for (const c of classified) {
    if (c.kind !== 'h264') continue;
    if (c.bitrate >= bestBr) {
      bestBr = c.bitrate;
      best = c.index;
    }
  }
  return { h264Indexes, best };
}

/** 探测流媒体编码；signal 用于换集时取消 */
export async function detectStreamCodec(url: string, signal?: AbortSignal): Promise<CodecInfo> {
  if (!url) {
    return { kind: 'unknown', label: '编码未识别', hint: '无播放地址' };
  }

  const { text } = await fetchText(url, signal);
  if (!text.includes('#EXTM3U')) {
    return { kind: 'unknown', label: '编码未识别', hint: '不是有效的 HLS 清单' };
  }

  const bodyFlags = classifyCodecText(text);
  if (hasAnyCodec(bodyFlags)) return toCodecInfo(bodyFlags);

  const master = parseMasterChildren(text);
  if (hasAnyCodec(master.flags)) return toCodecInfo(master.flags);

  // 多码率且无 CODECS：逐个子清单探测，再合并（避免只看第一档）
  if (master.childUrls.length > 1) {
    let agg = emptyFlags();
    for (const child of master.childUrls.slice(0, 4)) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const childFlags = await detectPlaylistFlags(child, signal);
      agg = mergeFlags(agg, childFlags);
    }
    if (hasAnyCodec(agg)) return toCodecInfo(agg);
  }

  const playlists = master.childUrls.length > 0 ? master.childUrls.slice(0, 1) : [null];
  for (const child of playlists) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const flags = child ? await detectPlaylistFlags(child, signal) : await detectPlaylistFlags(url, signal);
    if (hasAnyCodec(flags)) return toCodecInfo(flags);
  }

  return toCodecInfo(emptyFlags());
}
