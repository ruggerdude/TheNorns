// Minimal Resend client over raw fetch — no SDK dependency. Gated behind
// RESEND_API_KEY; callers get a clear typed error when it's not configured
// rather than a silent no-op, matching the live-planning key-guard pattern
// already established elsewhere in this server.
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("email sending requires RESEND_API_KEY to be set as an environment variable");
    this.name = "EmailNotConfiguredError";
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new EmailNotConfiguredError();
  const from = process.env.RESEND_FROM_EMAIL ?? "TheNorns <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: input.to, subject: input.subject, html: input.html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend request failed: ${res.status} ${detail}`);
  }
}
