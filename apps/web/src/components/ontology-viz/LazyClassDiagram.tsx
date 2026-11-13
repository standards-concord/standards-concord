import { lazy, type ComponentProps } from 'react';
import { pageChunk } from '../../lib/routeChunks';
import { RouteBoundary } from '../RouteBoundary';

/** The full diagram renderer and dagre are shared by Browse's two diagram views. */
const Diagram = lazy(pageChunk('diagram', () => import('./ClassDiagram').then((m) => ({ default: m.ClassDiagram }))));

/**
 * The diagram waits for its code inside its own boundary. Without one, the page around it (the class tree,
 * the term's details) was replaced by the tab's loading state while the code downloaded, and keyboard focus
 * in the tree was lost.
 */
export function ClassDiagram(props: ComponentProps<typeof Diagram>) {
  return <RouteBoundary><Diagram {...props} /></RouteBoundary>;
}
