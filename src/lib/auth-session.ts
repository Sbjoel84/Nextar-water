// Supabase decides whether a session has expired with the device's own clock.
// A phone/PC set an hour or more off makes every fresh session look expired
// (or never-expiring), so the background refresh fails and the user is
// signed out moments after "Welcome back" with no explanation. The access
// token's `iat` is the server's clock at sign-in, which tells us the skew.

const MAX_SKEW_SECONDS = 5 * 60;

// Device time minus server time, in seconds (positive = device is ahead).
export function deviceClockSkewSeconds(accessToken: string): number | null {
  try {
    const payload = JSON.parse(
      atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { iat?: number };
    if (typeof payload.iat !== "number") return null;
    return Math.round(Date.now() / 1000 - payload.iat);
  } catch {
    return null;
  }
}

function describeOffset(seconds: number): string {
  const abs = Math.abs(seconds);
  const amount =
    abs >= 86400
      ? `${Math.round(abs / 86400)} day(s)`
      : abs >= 3600
        ? `${Math.round(abs / 3600)} hour(s)`
        : `${Math.round(abs / 60)} minute(s)`;
  return `${amount} ${seconds > 0 ? "ahead of" : "behind"}`;
}

// A user-facing message when the device clock is too far off to keep a
// session, or null when it's fine.
export function clockSkewMessage(accessToken: string): string | null {
  const skew = deviceClockSkewSeconds(accessToken);
  if (skew === null || Math.abs(skew) <= MAX_SKEW_SECONDS) return null;
  return (
    `This device's date/time is about ${describeOffset(skew)} the correct time, ` +
    "so you would be signed out straight away. Set the date & time to automatic " +
    "in your device settings, then sign in again."
  );
}

// Set by the login page on success, so the app shell can tell "session
// vanished right after signing in" from an ordinary signed-out visit.
let signedInAt = 0;
export const markJustSignedIn = () => {
  signedInAt = Date.now();
};
export const consumeJustSignedIn = () => {
  const recent = signedInAt > 0 && Date.now() - signedInAt < 60_000;
  signedInAt = 0;
  return recent;
};

// Lets the app tell a sign-out the user asked for apart from a session that
// ended on its own (expired, revoked, refresh failed), which gets a message.
let intentionalSignOut = false;
export const markIntentionalSignOut = () => {
  intentionalSignOut = true;
};
export const consumeIntentionalSignOut = () => {
  const was = intentionalSignOut;
  intentionalSignOut = false;
  return was;
};
