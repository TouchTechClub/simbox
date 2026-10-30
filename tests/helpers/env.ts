// Tests must not inherit the calling agent's identity: it changes which run
// and cache file the CLI uses.
for (const name of ["SIMBOX_HOLDER", "SIMBOX_RUN", "T3CODE_THREAD_ID", "CLAUDE_CODE_SESSION_ID"])
  delete process.env[name];
