# Norns Local Agent distribution

The subscriber path must not require Git, Node.js, pnpm, PowerShell, or a source checkout.

## Desktop beta

`.github/workflows/local-agent-installer.yml` produces two beginner-facing installers:

- a per-user `Norns-Local-Agent-Setup.exe` for 64-bit Windows 10 and newer;
- a universal `Norns-Local-Agent-macOS.pkg` for Apple Silicon and Intel Macs running macOS 13
  or newer.

Both include:

- the built Norns runner and production dependencies;
- its own Node.js runtime;
- login startup and `norns-agent://` pairing registration.

The Windows installer also includes the pinned 64-bit MinGit distribution. macOS uses Apple's Git;
on a Mac without Command Line Tools, the app opens Apple's own installer and tells the subscriber to
click the connection link again after it finishes.

The public beta installers pin pairing to `https://thenorns.up.railway.app`; another website cannot
re-pair either app to an arbitrary relay through the registered protocol.

Unsigned and unnotarized workflow runs are retained only as authenticated GitHub Actions artifacts.
The workflow refuses to publish a GitHub prerelease unless Windows Authenticode signing and Mac
Developer ID signing plus notarization all succeed.

Configure Windows:

- secret `WINDOWS_CODESIGN_PFX_BASE64`;
- secret `WINDOWS_CODESIGN_PFX_PASSWORD`;
- optional variable `WINDOWS_CODESIGN_TIMESTAMP_URL`.

Configure macOS:

- secrets `APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64` and
  `APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64`;
- secret `APPLE_CERTIFICATE_PASSWORD`;
- variables `APPLE_DEVELOPER_ID_APPLICATION_IDENTITY` and
  `APPLE_DEVELOPER_ID_INSTALLER_IDENTITY`;
- secrets `APPLE_NOTARY_PRIVATE_KEY_BASE64`, `APPLE_NOTARY_KEY_ID`, and
  `APPLE_NOTARY_ISSUER_ID`.

Apple requires a Developer ID Application signature with hardened runtime, a Developer ID Installer
signature, and notarization before direct distribution. The workflow uses `notarytool`, staples the
ticket, and validates the result before it permits publication.

After publishing, configure the server with:

```text
NORNS_WINDOWS_AGENT_DOWNLOAD_URL=https://github.com/ruggerdude/TheNorns/releases/download/agent-v0.1.0/Norns-Local-Agent-Setup.exe
NORNS_MACOS_AGENT_DOWNLOAD_URL=https://github.com/ruggerdude/TheNorns/releases/download/agent-v0.1.0/Norns-Local-Agent-macOS.pkg
```

The Connections page will then offer **Download for Windows**, **Download for Mac**, and a one-use
**Connect installed agent** link. Without configured signed downloads, it honestly retains the
existing command-line installers under **Advanced command-line setup**.
