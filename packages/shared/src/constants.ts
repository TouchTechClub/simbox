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

jobs:
  simbox:
    runs-on: macos-latest
    timeout-minutes: 350
    steps:
      - name: Simbox agent
        uses: TouchTechClub/runner@v1
        with:
          token: \${{ secrets.SIMBOX_TOKEN }}
`;

/** Commit message used when installing the workflow file. */
export const WORKFLOW_COMMIT_MESSAGE = "chore: add simbox workflow";
