# Hybrid Provider Credential Runbook

This runbook covers credentials for native coding-agent execution. The
production path is **CodexRuntime** for OpenAI and **ClaudeCodeRuntime** for
Anthropic or DeepSeek. Open WebUI Computer is an optional local-only pilot; it
is not part of the production path and is not required for this release.

## Supported routes

| Provider | `credential_mode` | Runtime | Credential source |
|---|---|---|---|
| OpenAI | `api` | Codex | Server-held API key through a short-lived Norns gateway credential |
| OpenAI | `subscription` | Codex | Official ChatGPT login persisted by the local Codex CLI |
| Anthropic | `api` | Claude Code | Server-held API key through a short-lived Norns gateway credential |
| Anthropic | `subscription` | Claude Code | Official Claude subscription login persisted by the local Claude CLI |
| DeepSeek | `api` | Claude Code over DeepSeek's Anthropic-compatible endpoint | Server-held API key through a short-lived Norns gateway credential |
| DeepSeek | `subscription` | — | Unsupported and rejected |

`credential_mode` selects an authentication source; it is not a provider name
or a generic billing flag. An omitted legacy value resolves to `api`.

## API-mode setup

Set provider keys only on the server/control-plane deployment, such as Railway:

```text
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
DEEPSEEK_API_KEY=...
NORNS_RUNNER_ALLOWED_MODELS=anthropic/<exact-model-id>,openai/<exact-model-id>,deepseek/<exact-model-id>
```

Configure only the providers in use. `NORNS_RUNNER_ALLOWED_MODELS` contains
comma-separated, exact `provider/model` pairs after model resolution. Missing
or empty allowlist configuration permits no runner models. A provider key does
not make an unlisted model available.

Do not put provider API keys in runner configuration, repository secrets,
worktrees, or CI inputs. For an API run, the authenticated runner asks the
relay for a short-lived, run-scoped Norns credential. The relay keeps the real
provider key and forwards the provider-native streaming protocol. Confirm:

1. the provider key and exact model pair are present in the server deployment;
2. the runner is paired and the public relay origin is HTTPS;
3. the selected staffing entry uses `credential_mode: "api"`;
4. a smoke run reaches the expected provider gateway and creates canonical
   provider usage telemetry.

## Subscription-mode setup

Subscription credentials stay on the operator's computer in the official CLI
credential store. They are never minted by Norns, copied into a repository, or
sent to the relay.

For OpenAI/Codex, sign in with ChatGPT using the official Codex login flow and
verify:

```sh
codex login status
```

The probe must exit successfully and report exactly `Logged in using ChatGPT`.
An API-key, agent-identity, or logged-out status does not satisfy subscription
mode.

For Anthropic/Claude Code, use the official Claude account subscription login
and verify:

```sh
claude auth status --json
```

The probe accepts only `loggedIn: true`, `authMethod: "claude.ai"`, and a
recognized subscription type (`pro`, `max`, `team`, or `enterprise`). API-key
auth does not satisfy subscription mode even when the command says the user is
logged in. DeepSeek has no supported subscription route.

Keep the selected model in `NORNS_RUNNER_ALLOWED_MODELS`; subscription mode
waives the provider-API-key requirement, not model approval. The runner strips
provider API keys, token overrides, and provider base URLs from the child
environment so the native CLI can use only its persisted local login.

## Failure and no-fallback rules

Routing fails closed before the native runtime starts:

- explicit API mode without a gateway callback fails;
- an unavailable gateway, missing server key, unapproved model, authorization
  failure, or budget refusal does not fall back to a local login;
- subscription mode does not mint a gateway credential and does not fall back
  to an API key;
- a missing or mismatched local subscription probe stops the run;
- DeepSeek subscription selection is rejected;
- secrets and raw auth-command output are excluded from capability reports.

If a run fails this gate, correct the selected credential mode or its own
credential source. Do not fix it by placing both credential types in the child
environment.

## Cost semantics

API-mode provider calls are metered through the gateway and participate in the
run's API budget reservation. Provider-reported usage is canonical when
available; every amount retains its usage source and pricing version.

Subscription-mode activity is classified as subscription consumption, not API
dollar cost. Runtime token counts may be recorded as a labeled fallback, but
the system must not fabricate a provider invoice or mix subscription
consumption into metered-API totals. Subscription seats remain a separate
operator ledger and are not “free” merely because no incremental API charge is
recorded.

## Open WebUI Computer pilot disposition

Open WebUI Computer was evaluated as an optional local agent workspace and is
**deferred from the production path**. Native authenticated Codex and Claude
CLIs already provide the supported execution seam, so Computer is not required
for this release.

Any later pilot must meet all of these gates:

- local/non-production use only, on a test repository and disposable profile;
- bind only to an IP-literal loopback address (`127.0.0.1` or `::1`) and verify
  the listening socket before use; if the installed version cannot guarantee
  loopback binding, do not start the pilot;
- do not expose it through a public hostname, relay route, port forward, or
  shared network;
- treat access as equivalent to SSH: a signed-in user can receive filesystem
  and shell authority on the host;
- never extract, proxy, upload, or send Codex/Claude subscription tokens to the
  Norns relay or Open WebUI service; use only the official local CLI login;
- pin and review the exact artifact, security model, and data paths before
  enabling it;
- complete legal review of the source-available Open Use/commercial terms for
  Computer and the applicable Open WebUI license, including branding and
  enterprise-use conditions, before business use or redistribution.

The product's own documentation describes Computer as operating on the real
machine and warns that a signed-in user can have keyboard-equivalent filesystem
and shell access. Review the current [Computer documentation](https://docs.openwebui.com/ecosystem/computer/),
[Computer licensing FAQ](https://docs.openwebui.com/ecosystem/computer/faq/),
and [Open WebUI license](https://github.com/open-webui/open-webui/blob/main/LICENSE)
at pilot approval time; terms may change.

## Rollback

1. Pause new dispatches and cancel affected in-flight runs through the normal
   control path. Let short-lived gateway credentials expire or be revoked with
   the run; never copy them out for investigation.
2. Change Anthropic/OpenAI staffing selections back to the last known-good
   `credential_mode`. DeepSeek remains API-only.
3. For API rollback, restore the last known-good server key and exact
   `NORNS_RUNNER_ALLOWED_MODELS` value, redeploy the server, and run one bounded
   smoke test. Removing a provider/model allowlist entry disables new use of
   that route; removing the key disables that provider.
4. For subscription rollback, stop new subscription dispatches first. Use the
   official `codex logout` or `claude auth logout` only when the operator also
   intends to remove the local login; do not delete credential-store files by
   hand.
5. For an Open WebUI Computer pilot, stop the local process/container, remove
   its autostart and Norns test integration, verify the loopback port is closed,
   and archive or deliberately delete its local data according to policy. Do
   not destroy a persistent volume as an incidental troubleshooting step.
6. Confirm subsequent runs use only the restored route and that usage events
   retain the correct API or subscription classification.
