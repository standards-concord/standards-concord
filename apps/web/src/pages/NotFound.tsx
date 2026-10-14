import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { Page } from '../components/Shell';
import { Button, EmptyState } from '../components/ui';

export function NotFound() {
  return (
    <Page>
      <EmptyState icon={Compass} title="Page not found" action={<Link to="/"><Button variant="primary">Back to the hub</Button></Link>}>
        That link doesn’t lead anywhere. It may have been moved, or the item was removed.
      </EmptyState>
    </Page>
  );
}
