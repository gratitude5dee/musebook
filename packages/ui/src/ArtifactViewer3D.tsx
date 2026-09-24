// packages/ui/src/ArtifactViewer3D.tsx — §11.16's fullscreen r3f viewer.
// Reached only through next/dynamic(..., { ssr: false }) from apps/web when
// manifest.interactive is true and the user has expanded the card.
'use client';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useEffect, useState } from 'react';
import { DRACOLoader, KTX2Loader } from 'three-stdlib';
import { acquireWebglSlot, releaseWebglSlot } from './webglBudget';

const DRACO_DECODER = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

function Scene3D({ src }: { src: string }) {
  const gl = useThree((s) => s.gl);
  const { scene } = useGLTF(src, true, true, (loader) => {
    // §11.16: decode paths load into the HOST page, never into the frame —
    // the artifact CSP is script-src 'self' and would block gstatic.com anyway.
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODER);
    loader.setDRACOLoader(draco);
    const ktx2 = new KTX2Loader();
    ktx2.detectSupport(gl);
    loader.setKTX2Loader(ktx2);
  });

  // Dispose geometries, materials and textures, then forceContextLoss — GC
  // alone is how the two-context budget gets exceeded by dead viewers (§11.16).
  useEffect(() => {
    return () => {
      scene.traverse((obj) => {
        const mesh = obj as unknown as {
          geometry?: { dispose(): void };
          material?: unknown;
        };
        mesh.geometry?.dispose();
        const mats = mesh.material;
        const list = Array.isArray(mats) ? mats : mats ? [mats] : [];
        for (const m of list) {
          const mat = m as Record<string, unknown> & { dispose?: () => void };
          for (const v of Object.values(mat)) {
            const disposable = v as { dispose?: () => void } | null;
            if (disposable !== null && typeof disposable === 'object' && typeof disposable.dispose === 'function') {
              disposable.dispose();
            }
          }
          mat.dispose?.();
        }
      });
      gl.forceContextLoss();
    };
  }, [gl, scene]);

  return <primitive object={scene} />;
}

export function ArtifactViewer3D({ src, id }: { src: string; id: string }) {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    const ok = acquireWebglSlot(id);
    setGranted(ok);
    return () => {
      if (ok) releaseWebglSlot(id);
    };
  }, [id]);

  if (granted !== true) return null; // over budget: the poster stays mounted
  const mobile = typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent);
  return (
    <Canvas
      gl={{ powerPreference: 'high-performance', antialias: false }}
      dpr={mobile ? 1.5 : Math.min(globalThis.devicePixelRatio ?? 1, 2)}
      camera={{ position: [0, 0.8, 2.4], fov: 45 }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 6, 4]} intensity={1} />
      <Scene3D src={src} />
    </Canvas>
  );
}
