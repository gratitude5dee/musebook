// packages/ui/src/model-viewer.d.ts — React 19 declaration for <model-viewer>.
import type { ModelViewerElement } from '@google/model-viewer';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<
        React.HTMLAttributes<ModelViewerElement> & Record<string, unknown>,
        ModelViewerElement
      >;
    }
  }
}
