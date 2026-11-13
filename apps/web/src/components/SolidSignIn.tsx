import { lazy, useState } from 'react';
import { pageChunk } from '../lib/routeChunks';
import { RouteBoundary } from './RouteBoundary';
import { SolidIcon } from './badges';
import { Button } from './ui';

const SolidSignInDialog = lazy(pageChunk('solid-sign-in', () => import('./SolidSignInDialog').then((m) => ({ default: m.SolidSignInDialog }))));

/** Keep the sign-in choice immediate; download the provider dialog only when it is opened. */
export function SolidSignIn(props: { next: string; error?: string }) {
  const [opened, setOpened] = useState(false);
  if (opened || props.error) return <RouteBoundary><SolidSignInDialog {...props} /></RouteBoundary>;
  return <Button size="lg" className="w-full" onClick={() => setOpened(true)}><SolidIcon /> Sign in with Solid</Button>;
}
