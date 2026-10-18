import { ScreenShell } from '@/design/screen-shell';

export default function LaunchScreen() {
  return (
    <ScreenShell
      name="Launch"
      step="Step 1: the user pastes a URL and a mission"
      fixture="hoodieMission"
      mustShow={[
        'Storefront URL field.',
        'Mission field with the hoodie example as placeholder.',
        'Agent checkboxes: Alpha, Beta, Sigma, Gamma, each with its model and a cost hint.',
        'Optional "connect a repository now" link. Never required here.',
        'Start button. Nothing else on the screen.',
      ]}
    />
  );
}
