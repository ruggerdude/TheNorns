// Real user accounts: password hashing round-trip, session lifecycle,
// manual-add vs. email-invite, and durable round-trip through a snapshot.
import { describe, expect, it } from "vitest";
import {
  InvalidCredentialsError,
  InvalidInviteError,
  UserExistsError,
  UserNotFoundError,
  UserStore,
} from "../src/users/store.js";

describe("UserStore — accounts and sessions", () => {
  it("creates an active user and logs in with the right password", () => {
    const store = new UserStore();
    const created = store.createActive({
      email: "Ada@Example.com", // mixed case — should normalize
      name: "Ada",
      password: "correct horse battery staple",
      role: "admin",
    });
    expect(created.email).toBe("ada@example.com");
    expect(created.status).toBe("active");

    const { token, user } = store.login("ada@example.com", "correct horse battery staple");
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(user.id).toBe(created.id);
    expect(store.userForToken(token)?.id).toBe(created.id);
  });

  it("rejects the wrong password without revealing whether the email exists", () => {
    const store = new UserStore();
    store.createActive({ email: "a@x.com", password: "correct-password", role: "member" });
    expect(() => store.login("a@x.com", "wrong-password")).toThrow(InvalidCredentialsError);
    expect(() => store.login("nobody@x.com", "whatever")).toThrow(InvalidCredentialsError);
  });

  it("never stores the plaintext password", () => {
    const store = new UserStore();
    store.createActive({ email: "a@x.com", password: "super-secret-value", role: "member" });
    const snapshot = JSON.stringify(store.snapshot());
    expect(snapshot).not.toContain("super-secret-value");
  });

  it("rejects a duplicate email (case-insensitive)", () => {
    const store = new UserStore();
    store.createActive({ email: "a@x.com", password: "p", role: "member" });
    expect(() => store.createActive({ email: "A@X.com", password: "p2", role: "member" })).toThrow(
      UserExistsError,
    );
  });

  it("logout invalidates the session", () => {
    const store = new UserStore();
    store.createActive({ email: "a@x.com", password: "password1", role: "admin" });
    const { token } = store.login("a@x.com", "password1");
    expect(store.userForToken(token)).toBeDefined();
    store.logout(token);
    expect(store.userForToken(token)).toBeUndefined();
  });

  it("removing a user also invalidates their sessions", () => {
    const store = new UserStore();
    const created = store.createActive({ email: "a@x.com", password: "password1", role: "admin" });
    const { token } = store.login("a@x.com", "password1");
    store.remove(created.id);
    expect(store.userForToken(token)).toBeUndefined();
    expect(() => store.remove(created.id)).toThrow(UserNotFoundError);
  });

  it("email invite: no password until accepted, then a real session is possible", () => {
    const store = new UserStore();
    const { summary, inviteToken } = store.createInvite({ email: "b@x.com", role: "member" });
    expect(summary.status).toBe("invited");
    expect(() => store.login("b@x.com", "anything")).toThrow(InvalidCredentialsError);

    const accepted = store.acceptInvite(inviteToken, "new-password-123");
    expect(accepted.status).toBe("active");
    const { token } = store.login("b@x.com", "new-password-123");
    expect(store.userForToken(token)?.email).toBe("b@x.com");

    // the token is single-use — it was cleared on acceptance
    expect(() => store.acceptInvite(inviteToken, "another")).toThrow(InvalidInviteError);
  });

  it("an invite also blocks a duplicate email, same as manual add", () => {
    const store = new UserStore();
    store.createActive({ email: "a@x.com", password: "p", role: "member" });
    expect(() => store.createInvite({ email: "a@x.com", role: "member" })).toThrow(UserExistsError);
  });

  it("round-trips users and live sessions through a snapshot", () => {
    const store = new UserStore();
    store.createActive({ email: "admin@x.com", password: "pw", role: "admin" });
    const { token } = store.login("admin@x.com", "pw");
    store.createInvite({ email: "pending@x.com", role: "member" });

    const restored = new UserStore();
    restored.restoreFrom(store.snapshot());

    expect(restored.count).toBe(2);
    expect(restored.userForToken(token)?.email).toBe("admin@x.com"); // session survived
    expect(restored.list().find((u) => u.email === "pending@x.com")?.status).toBe("invited");
    expect(restored.snapshot()).toEqual(store.snapshot());
  });
});
