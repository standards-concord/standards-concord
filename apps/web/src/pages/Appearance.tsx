import { Page } from '../components/Shell';
import { LookPicker } from '../components/LookPicker';
import { PageHeader } from '../components/ui';

/** Public page: choose the app's visual style. It's saved in this browser, so it works signed out too. */
export function AppearancePage() {
  return (
    <Page>
      <PageHeader title="Appearance" subtitle="Choose how Concord looks. Your choice is saved in this browser." />
      <LookPicker level={2} />
    </Page>
  );
}
