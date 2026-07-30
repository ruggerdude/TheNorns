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
- per-user login startup and the loopback AgentHost Control Center;
- persisted-key device enrollment through the Control Center, without a custom
  URI or an enrollment secret on a command line.

The Windows installer also includes the pinned 64-bit MinGit distribution. macOS uses Apple's Git;
on a Mac without Command Line Tools, the app opens Apple's own installer and tells the subscriber to
open the Control Center again after it finishes.

The public beta installers pin enrollment to `https://thenorns.up.railway.app`.
The native launcher authenticates the loopback AgentHost before opening its
short-lived, one-use browser bootstrap. AgentHost applies exact IP-literal
Host/Origin checks, CSRF protection, no CORS, bundled assets, and a strict CSP.

Unsigned and unnotarized workflow runs are retained only as authenticated GitHub Actions artifacts.
The workflow refuses to publish a GitHub prerelease unless Windows Authenticode signing and Mac
Developer ID signing plus notarization all succeed. Published version tags and
assets are immutable: updates use a newly versioned signed package and are
installed manually.

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
NORNS_MACOS_AGENT_RELEASE_CHANNEL=notarized
```

The configured URLs identify the immutable signed packages used by the
deployment's manual installation and update guidance. Device approval itself
uses the code-free website approval page and a throttled POSTed human code; the
256-bit device code stays in protected agent storage and enrollment POST
bodies.

## Temporary unsigned Mac preview

An unsigned preview may be published as a clearly marked GitHub prerelease while Developer ID
credentials are being established. Use a release asset whose filename includes `UNSIGNED`, then set:

```text
NORNS_MACOS_AGENT_DOWNLOAD_URL=https://github.com/ruggerdude/TheNorns/releases/download/<preview-tag>/Norns-Local-Agent-macOS-UNSIGNED.pkg
NORNS_MACOS_AGENT_RELEASE_CHANNEL=unsigned_preview
```

Connections must retain the unsigned warning and Gatekeeper instructions for as long as that channel
is enabled. Never relabel an unsigned artifact as notarized. Replace the URL and channel after the
signed package passes `notarytool`, stapling, and Gatekeeper validation.
