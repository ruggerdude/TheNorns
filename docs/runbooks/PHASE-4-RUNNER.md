# Phase 4 Local Runner Configuration

The Phase 4 executor is enabled when the runner process has a local repository
binding map. Repository paths and verification commands remain runner-local;
they are never persisted by the control plane.

## Required environment

```text
NORNS_APPROVED_ROOTS_JSON=["/absolute/approved/root"]
NORNS_REPOSITORY_BINDINGS_JSON={"binding-id-from-project":"/absolute/approved/root/repository"}
NORNS_VERIFICATION_POLICIES_JSON={"verification-policy-ref":["pnpm","test"]}
```

Then start the paired runner normally:

```text
norns-runner start --server https://your-control-plane --id runner-1
```

The repository binding is rejected unless its resolved path is inside an
approved root. Verification commands use an executable plus argument array;
they are not passed through a shell. Context references must be signed HTTPS
URLs (plain HTTP is permitted only for localhost development), and their byte
length and SHA-256 hash are checked before use.

The runner stages context in its private scratch directory, creates a detached
Git worktree under its data directory, invokes only the runtime named by the
dispatch command, verifies the resulting exact commit, emits structured
events, and removes the worktree and scratch context afterward.

