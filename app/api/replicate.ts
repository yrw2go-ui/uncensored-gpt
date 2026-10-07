import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import {
  ACCESS_CODE_PREFIX,
  ModelProvider,
  REPLICATE_BASE_URL,
} from "@/app/constant";
import { auth } from "@/app/api/auth";

// only the endpoints LoRA Studio needs are forwarded, so a server-side
// token can't be used to reach the rest of the Replicate API
const ALLOWED_PATHS = [
  /^v1\/account$/,
  /^v1\/files$/,
  /^v1\/models$/,
  /^v1\/models\/[\w.-]+\/[\w.-]+$/,
  /^v1\/models\/[\w.-]+\/[\w.-]+\/versions\/\w+\/trainings$/,
  /^v1\/trainings\/\w+(\/cancel)?$/,
  /^v1\/predictions(\/\w+)?$/,
];

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[Replicate] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const path = params.path.join("/");
  if (!ALLOWED_PATHS.some((re) => re.test(path))) {
    return NextResponse.json(
      { error: true, message: `path not allowed: ${path}` },
      { status: 403 },
    );
  }

  // read the user's own token before auth() rewrites the header
  const userToken = (req.headers.get("Authorization") ?? "")
    .replaceAll("Bearer ", "")
    .trim();

  const authResult = auth(req, ModelProvider.Stability);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  const serverConfig = getServerSideConfig();
  const key =
    userToken && !userToken.startsWith(ACCESS_CODE_PREFIX)
      ? userToken
      : serverConfig.replicateApiToken;

  if (!key) {
    return NextResponse.json(
      {
        error: true,
        message: `missing REPLICATE_API_TOKEN in server env vars`,
      },
      { status: 401 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  const fetchUrl = `${REPLICATE_BASE_URL}/${path}${req.nextUrl.search}`;
  console.log("[Replicate Url] ", fetchUrl);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
  };
  const contentType = req.headers.get("Content-Type");
  if (contentType) headers["Content-Type"] = contentType;

  try {
    const res = await fetch(fetchUrl, {
      headers,
      method: req.method,
      body: req.method === "GET" ? undefined : req.body,
      redirect: "manual",
      // @ts-ignore
      duplex: "half",
      signal: controller.signal,
    });
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    newHeaders.set("X-Accel-Buffering", "no");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
