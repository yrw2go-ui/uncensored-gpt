import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getSql, isNeonConfigured } from "@/app/neon/server";

// per-user saved chats, prompts, masks and settings (never API keys)
async function handle(req: NextRequest) {
  if (!isNeonConfigured()) {
    return NextResponse.json({ error: "not configured" }, { status: 501 });
  }

  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sql = getSql();

  if (req.method === "GET") {
    const rows = await sql`
      select state, updated_at from user_chat_state where user_id = ${user.id}
    `;
    return NextResponse.json({
      state: rows[0]?.state ?? null,
      updatedAt: rows[0]?.updated_at ?? null,
    });
  }

  const body = await req.json().catch(() => null);
  if (!body?.state || typeof body.state !== "object") {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }

  await sql`
    insert into user_chat_state (user_id, state, updated_at)
    values (${user.id}, ${JSON.stringify(body.state)}::jsonb, now())
    on conflict (user_id)
    do update set state = excluded.state, updated_at = excluded.updated_at
  `;
  return NextResponse.json({ ok: true });
}

export const GET = handle;
export const PUT = handle;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
