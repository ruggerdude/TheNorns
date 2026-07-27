# Norns Local Agent distribution

The subscriber path must not require Git, Node.js, pnpm, PowerShell, or a source checkout.

## Windows beta

`.github/workflows/local-agent-installer.yml` produces a per-user
`Norns-Local-Agent-Setup.exe` containing:

- the built Norns runner and production dependencies;
- its own Node.js runtime;
- the pinned 64-bit MinGit distribution;
- login startup and `norns-agent://` pairing registration.

The public beta installer pins pairing to `https://thenorns.up.railway.app`; another website cannot
re-pair it to an arbitrary relay through the registered protocol.

Unsigned workflow runs are retained only as authenticated GitHub Actions artifacts. The workflow
refuses to publish a GitHub prerelease unless Authenticode signing succeeds.

Configure:

- secret `WINDOWS_CODESIGN_PFX_BASE64`;
- secret `WINDOWS_CODESIGN_PFX_PASSWORD`;
- optional variable `WINDOWS_CODESIGN_TIMESTAMP_URL`.

After publishing, configure the server with:

```text
NORNS_WINDOWS_AGENT_DOWNLOAD_URL=https://github.com/ruggerdude/TheNorns/releases/download/agent-v0.1.0/Norns-Local-Agent-Setup.exe
```

The Connections page will then offer **Download for Windows** and a one-use **Connect installed
agent** link. Without a configured signed download, it honestly retains the existing command-line
installer under **Advanced command-line setup**.

## macOS

The same response contract already supports `NORNS_MACOS_AGENT_DOWNLOAD_URL`. A signed,
Developer-ID-notarized universal app or disk image must be produced before that value is enabled.
