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

export function toCodecInfo(c: CodecFlags): CodecInfo {
  if (c.has265 && c.has264) {
    return {
      kind: 'mixed',
      label: 'H.264 / H.265',
      hint: '多码率混编 · 投屏请选 H.264 清晰度',
    };
  }
  if (c.has265) {
    return {
      kind: 'h265',
      label: 'H.265 (HEVC)',
      hint: 'AirPlay 投屏可能只有声音',
    };
  }
  if (c.has264) {
    return {
      kind: 'h264',
      label: 'H.264 (AVC)',
      hint: '适合 AirPlay 投屏',
    };
  }
  if (c.hasAv1) {
    return {
      kind: 'av1',
      label: 'AV1',
      hint: 'AirPlay 兼容性较差',
    };
  }
  return {
    kind: 'unknown',
    label: '编码未知',
    hint: '清单未声明 CODECS，且无法从分片识别',
  };
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

  let isTs = false;
  for (let s = 0; s < Math.min(buf.length, 188); s++) {
    if (buf[s] === 0x47 && s + 188 < buf.length && buf[s + 188] === 0x47) {
      isTs = true;
      break;
    }
  }
  if (!isTs) return out;

  for (let i = 0; i < buf.length - 6; i++) {
    if (buf[i] === 0x02 && (buf[i + 1] & 0xf0) === 0xb0) {
      const end = Math.min(buf.length, i + 400);
      for (let j = i + 12; j < end; j++) {
        const st = buf[j];
        if (st === 0x1b || st === 0x20 || st === 0x27) out.has264 = true;
        if (st === 0x24 || st === 0x25) out.has265 = true;
      }
    }
  }

  for (let k = 0; k < buf.length - 5; k++) {
    let nalPos = -1;
    if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 1) nalPos = k + 3;
    else if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 0 && buf[k + 3] === 1) nalPos = k + 4;
    if (nalPos < 0 || nalPos >= buf.length) continue;
    const nb = buf[nalPos];
    const hevcType = (nb >> 1) & 0x3f;
    if (hevcType === 32 || hevcType === 33 || hevcType === 34) out.has265 = true;
    const avcType = nb & 0x1f;
    if ((nb & 0x80) === 0 && (avcType === 7 || avcType === 8)) out.has264 = true;
  }

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

/** 探测流媒体编码；signal 用于换集时取消 */
export async function detectStreamCodec(url: string, signal?: AbortSignal): Promise<CodecInfo> {
  if (!url) {
    return { kind: 'unknown', label: '编码未知', hint: '无播放地址' };
  }

  const { text } = await fetchText(url, signal);
  if (!text.includes('#EXTM3U')) {
    return { kind: 'unknown', label: '编码未知', hint: '不是有效的 HLS 清单' };
  }

  const bodyFlags = classifyCodecText(text);
  if (hasAnyCodec(bodyFlags)) return toCodecInfo(bodyFlags);

  const master = parseMasterChildren(text);
  if (hasAnyCodec(master.flags)) return toCodecInfo(master.flags);

  const playlists = master.childUrls.length > 0 ? master.childUrls.slice(0, 2) : [null];

  for (const child of playlists) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const mediaText = child ? (await fetchText(child, signal)).text : text;
    const mediaFlags = classifyCodecText(mediaText);
    if (hasAnyCodec(mediaFlags)) return toCodecInfo(mediaFlags);

    for (const target of parseMediaTargets(mediaText).slice(0, 2)) {
      try {
        const bytes = await fetchBytes(target, signal);
        const segFlags = detectFromBytes(bytes);
        if (hasAnyCodec(segFlags)) return toCodecInfo(segFlags);
      } catch {
        /* 单个分片失败继续试下一个 */
      }
    }
  }

  return toCodecInfo(emptyFlags());
}
