import { ScreenShell } from '@/design/screen-shell';

export default function IssueScreen() {
  return (
    <ScreenShell
      name="Issue"
      step="Step 5: the repository is asked for here, on the issue, not at launch"
      fixture="alphaIssue, alphaRepair"
      mustShow={[
        'Observed facts: the screenshot, the accessibility tree excerpt, the cart response.',
        'The hypothesis, labelled as written by the model.',
        'The ask: "connect your repo and we will propose a patch for this issue".',
        'The proposed diff once a repository is connected.',
        'Apply, with the merchant in control of whether it runs.',
      ]}
    />
  );
}
