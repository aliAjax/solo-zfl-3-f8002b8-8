import type { HighlightSegment } from '@/utils/search';

interface HighlightTextProps {
  segments: HighlightSegment[];
  className?: string;
}

/** 把检索片段渲染成文本，命中部分用高亮标出 */
export default function HighlightText({ segments, className }: HighlightTextProps) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className={`bg-ochre/25 text-ochre rounded-sm px-0.5 font-medium ${className ?? ''}`}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
