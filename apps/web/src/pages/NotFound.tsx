
import { Compass } from 'lucide-react';
import { Page } from '../components/Shell';
import { EmptyState, LinkButton } from '../components/ui';

export function NotFound() {
  return (
    <Page>
      <EmptyState icon={Compass} title="Page not found" action={<LinkButton to="/" variant="primary">Back to the hub</LinkButton>}>
        That link doesn’t lead anywhere. It may have been moved, or the item was removed.
      </EmptyState>
    </Page>
  );
}
