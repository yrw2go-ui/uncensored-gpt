import { NextRequest, NextResponse } from "next/server";
import {
  extractNeonAuthCookies,
  getNeonAuthBaseUrl,
  isNeonConfigured,
} from "@/app/neon/server";

// same-origin proxy to Neon Auth, so its session cookies are first-party
const FORWARD_REQUEST_HEADERS = [
  "user-agent",
  "authorization",
  "referer",
  "content-type",
];
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "set-auth-jwt",
  "set-auth-token",
];

function rewriteSetCookie(cookie: string) {
  return (
    cookie
      .split(";")
      .map((part) => part.trim())
      .filter((part) => {
        const name = part.split("=")[0].toLowerCase();
        return name !== "domain" && name !== "partitioned";
      })
      .map((part) =>
        part.toLowerCase().startsWith("samesite=") ? "SameSite=Lax" : part,
      )
      .join("; ") + (/;\s*secure/i.test(cookie) ? "" : "; Secure")
  );
}

async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  if (!isNeonConfigured()) {
    return NextResponse.json({ error: "not configured" }, { status: 501 });
  }

  const upstream = new URL(`${getNeonAuthBaseUrl()}/${params.path.join("/")}`);
  upstream.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", req.headers.get("origin") ?? req.nextUrl.origin);
  const cookie = extractNeonAuthCookies(req.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);

  let res: Response;
  try {
    res = await fetch(upstream, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : await req.text(),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e) {
    console.error("[Neon Auth] upstream fetch failed", e);
    return NextResponse.json({ error: "auth unavailable" }, { status: 502 });
  }

  const resHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) resHeaders.set(name, value);
  }
  const location = res.headers.get("location");
  if (location) resHeaders.set("location", location);
  for (const c of res.headers.getSetCookie()) {
    resHeaders.append("set-cookie", rewriteSetCookie(c));
  }

  return new Response(res.body, { status: res.status, headers: resHeaders });
}

export const GET = handle;
export const POST = handle;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
