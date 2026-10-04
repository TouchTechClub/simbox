export const PROD_API_URL = "https://api.simbox.touchtech.club";

/** Repo secret written into the user's repository; authenticates run registration. */
export const REPO_SECRET_NAME = "SIMBOX_TOKEN";

/** Path of the workflow file we commit to the user's repo. */
export const WORKFLOW_PATH = ".github/workflows/simbox.yml";

/** Local port the agent-device proxy binds on the runner (localhost only). */
export const PROXY_PORT = 4310;

/** Agent-runner lifecycle, in minutes. */
export const IDLE_EXIT_MINUTES = 15;
export const HARD_EXIT_MINUTES = 345; // 5h45m — clean cleanup before GH's 360 kill
export const HEARTBEAT_INTERVAL_SECONDS = 60;

/** Soft advisory cap on devices per run (enforced at ensure time). */
export const MAX_DEVICES_PER_RUN = 3;

/**
 * Canonical workflow committed to the user's repo.
 * Keep minimal — api_url override lives in the composite action default,
 * not here, so the committed file stays stable across environments.
 *
 * Use the stable macOS image by default. Users requiring preview-only device
 * types can opt into `xcode-27` in their workflow, accepting preview instability.
 */
export const WORKFLOW_YAML = `name: simbox

on:
  workflow_dispatch:
    inputs:
      platform:
        type: choice
        options: [ios, android]
        default: ios
        description: Device platform (Android uses Linux/KVM)

jobs:
  simbox:
    runs-on: \${{ inputs.platform == 'android' && 'ubuntu-latest' || 'macos-latest' }}
    timeout-minutes: 350
    steps:
      - name: Enable Android KVM access
        if: \${{ inputs.platform == 'android' }}
        run: |
          test -e /dev/kvm || { echo "KVM is required for Android" >&2; exit 1; }
          sudo chmod 666 /dev/kvm
      - name: Simbox agent
        uses: TouchTechClub/runner@v1
        with:
          token: \${{ secrets.SIMBOX_TOKEN }}
`;

/** Commit message used when installing the workflow file. */
export const WORKFLOW_COMMIT_MESSAGE = "chore: add simbox workflow";
