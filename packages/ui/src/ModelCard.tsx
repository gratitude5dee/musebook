// packages/ui/src/ModelCard.tsx — §11.16's feed card renderer.
'use client';
import { useEffect, useRef, useState } from 'react';
import { acquireWebglSlot, releaseWebglSlot } from './webglBudget';

export function ModelCard({ lodUrl, posterUrl, title }: { lodUrl: string; posterUrl: string; title: string }) {
  const [live, setLive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void import('@google/model-viewer');
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        if (entry.isIntersecting) {
          if (acquireWebglSlot(title)) setLive(true);
        } else if (live) {
          releaseWebglSlot(title);
          setLive(false);
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      releaseWebglSlot(title);
    };
  }, [live, title]);

  return (
    <div ref={ref}>
      {live ? (
        <model-viewer
          src={lodUrl}
          poster={posterUrl}
          alt={title}
          loading="lazy"
          reveal="interaction"
          camera-controls
          touch-action="pan-y"
          environment-image="neutral"
          shadow-intensity="1"
          ar
          ar-modes="webxr scene-viewer quick-look"
        />
      ) : (
        <img src={posterUrl} alt={title} loading="lazy" width={1200} height={675} />
      )}
    </div>
  );
}
