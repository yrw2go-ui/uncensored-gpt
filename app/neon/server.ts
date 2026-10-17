import { neon } from "@neondatabase/serverless";

// Neon Auth (Better Auth) sets its cookies with this prefix
const NEON_AUTH_COOKIE_PREFIX = "__Secure-neon-auth";

export type NeonUser = {
  id: string;
  email: string;
  name?: string;
};

export function getNeonAuthBaseUrl() {
  return process.env.NEON_AUTH_BASE_URL?.replace(/\/+$/, "") ?? "";
}

export function isNeonConfigured() {
  return !!getNeonAuthBaseUrl() && !!process.env.DATABASE_URL;
}

export function getSql() {
  return neon(process.env.DATABASE_URL!);
}

// only forward Neon Auth cookies upstream, never the app's other cookies
export function extractNeonAuthCookies(cookieHeader: string | null) {
  if (!cookieHeader) return "";
  return cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(NEON_AUTH_COOKIE_PREFIX))
    .join("; ");
}

export async function getSessionUser(req: Request): Promise<NeonUser | null> {
  const cookie = extractNeonAuthCookies(req.headers.get("cookie"));
  if (!cookie) return null;

  const res = await fetch(`${getNeonAuthBaseUrl()}/get-session`, {
    headers: { cookie },
    cache: "no-store",
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  const user = data?.user;
  if (!user?.id) return null;
  return { id: user.id, email: user.email, name: user.name };
}
