'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  detectStreamCodec,
  type CodecInfo,
  type CodecKind,
} from '@/lib/stream-codec';

const KIND_STYLE: Record<CodecKind, string> = {
  h264: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  h265: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  mixed: 'border-line bg-chip text-content',
  av1: 'border-line bg-chip text-content',
  unknown: 'border-line bg-chip text-muted',
  detecting: 'border-line bg-chip text-faint',
};

interface CodecHintProps {
  /** 当前集播放地址（m3u8） */
  url?: string;
  /** 播放器侧已解析到的编码（优先展示） */
  fromPlayer?: CodecInfo | null;
  className?: string;
}

/**
 * 剧集列表下方的编码提示：优先用播放器 hls.js 解析结果，否则走代理探测清单/分片。
 */
export function CodecHint({ url, fromPlayer, className }: CodecHintProps) {
  const [probed, setProbed] = useState<CodecInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const playerReady =
    !!fromPlayer && fromPlayer.kind !== 'unknown' && fromPlayer.kind !== 'detecting';

  useEffect(() => {
    if (playerReady) {
      setProbed(null);
      setLoading(false);
      return;
    }
    if (!url) {
      setProbed(null);
      return;
    }

    const ac = new AbortController();
    setLoading(true);
    setProbed({ kind: 'detecting', label: '编码检测中…', hint: '正在分析当前流' });

    detectStreamCodec(url, ac.signal)
      .then((info) => {
        if (!ac.signal.aborted) setProbed(info);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setProbed({
          kind: 'unknown',
          label: '编码未知',
          hint: err instanceof Error ? err.message : '探测失败',
        });
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [url, playerReady]);

  const info =
    fromPlayer && fromPlayer.kind !== 'unknown' && fromPlayer.kind !== 'detecting'
      ? fromPlayer
      : probed;

  if (!info && !loading) return null;

  const shown = info ?? {
    kind: 'detecting' as const,
    label: '编码检测中…',
    hint: '正在分析当前流',
  };

  return (
    <div
      className={cn(
        'mt-3 rounded-lg border px-2.5 py-2 text-xs leading-relaxed',
        KIND_STYLE[shown.kind],
        className
      )}
      role="status"
      aria-live="polite"
    >
      <div className="font-semibold tracking-wide">{shown.label}</div>
      {shown.hint && <div className="mt-0.5 opacity-90">{shown.hint}</div>}
    </div>
  );
}
