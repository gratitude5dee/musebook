// packages/ui/src/ArtifactCanvas.tsx — §14.4.6's shared artifact chrome.
'use client';
import { useEffect, useRef, useState } from 'react';
import type { ArtifactKind } from '@musebook/artifacts';
import { ArtifactFrame } from './ArtifactFrame';
import { ModelCard } from './ModelCard';

export interface ArtifactCanvasProps {
  kind: ArtifactKind;
  /** For 'app': the full artifacts-origin URL (free or ticketed).
   *  For 'model3d': the LOD GLB URL. */
  src: string;
  /** REQUIRED. Nothing 3D or interactive loads until the viewer asks for it.
   *  Always a cdn.musebook.dev URL — a poster is a teaser and is never gated (§11.11). */
  posterUrl: string;
  aspectRatio?: `${number}/${number}`;   // default '16/10'
  title: string;
  authorHandle: string;
  allowFullscreen?: boolean;             // default true
  /** Where the Fork affordance points; absent = fork hidden. */
  forkUrl?: string;
}

export function ArtifactCanvas({
  kind,
  src,
  posterUrl,
  aspectRatio = '16/10',
  title,
  authorHandle,
  allowFullscreen = true,
  forkUrl,
}: ArtifactCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (isFullscreen) {
      void document.exitFullscreen();
    } else {
      void rootRef.current?.requestFullscreen();
    }
  };

  return (
    <div ref={rootRef} className="artifact-canvas" style={{ background: 'canvas' }}>
      <div
        className="artifact-chrome-top"
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 12px',
        }}
      >
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <span style={{ opacity: 0.7 }}>@{authorHandle}</span>
        <span className="artifact-kind-badge" style={{ fontSize: 12, opacity: 0.7 }}>
          {kind === 'model3d' ? '3D' : 'app'}
        </span>
        <span style={{ flex: 1 }} />
        {allowFullscreen ? (
          <button type="button" onClick={toggleFullscreen}>
            {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        ) : null}
        <a href={src} target="_blank" rel="noopener noreferrer">
          Open in new tab
        </a>
        {forkUrl !== undefined ? <a href={forkUrl}>Fork</a> : null}
      </div>
      <div
        className="artifact-body"
        style={{
          aspectRatio: isFullscreen ? undefined : aspectRatio,
          height: isFullscreen ? 'calc(100% - 80px)' : undefined,
        }}
      >
        {kind === 'model3d' ? (
          <ModelCard lodUrl={src} posterUrl={posterUrl} title={title} />
        ) : (
          <ArtifactFrame src={src} title={title} />
        )}
      </div>
      <div
        className="artifact-chrome-bottom"
        style={{ height: 36, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', fontSize: 12 }}
      >
        <span style={{ opacity: 0.7 }}>Runs in a sandbox</span>
        <a href="/report" style={{ opacity: 0.7 }}>
          Report
        </a>
      </div>
    </div>
  );
}
