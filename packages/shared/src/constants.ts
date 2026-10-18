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

/** Commit message used when installing the workflow file. */
export const WORKFLOW_COMMIT_MESSAGE = "chore: add simbox workflow";
