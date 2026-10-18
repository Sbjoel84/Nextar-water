// TEMPORARY: Supabase sign-in is switched off until the new Supabase project
// and its accounts exist. While true, the landing page checks the demo
// credentials below instead of Supabase, the app shell only requires that
// local demo session, and every permission hook grants full access.
// Set to false to restore normal authentication.
export const AUTH_DISABLED = true;

// Local-only demo account. Not a real user: nothing is stored in a database.
export const DEMO_EMAIL = "admin@nextar.demo";
export const DEMO_PASSWORD = "Nextar@2026";

const DEMO_SESSION_KEY = "nextar-demo-session";

export function demoSignIn(email: string, password: string): boolean {
  if (email.trim().toLowerCase() !== DEMO_EMAIL || password !== DEMO_PASSWORD) return false;
  try {
    localStorage.setItem(DEMO_SESSION_KEY, DEMO_EMAIL);
  } catch {
    // Storage blocked: sign-in still works for this page load.
  }
  return true;
}

export function isDemoSignedIn(): boolean {
  try {
    return localStorage.getItem(DEMO_SESSION_KEY) === DEMO_EMAIL;
  } catch {
    return false;
  }
}

export function demoSignOut() {
  try {
    localStorage.removeItem(DEMO_SESSION_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
