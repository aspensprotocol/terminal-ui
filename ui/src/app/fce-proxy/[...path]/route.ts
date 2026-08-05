/**
 * Server-side relay to the Flare FCE ext-proxy.
 *
 * The browser must never see `DIRECT_API_KEY`. Anything read in a `"use client"`
 * module — which `lib/api.ts` is — ends up in the bundle, so the key is injected
 * here, on the server, and the browser only ever talks to a same-origin path.
 *
 * NOT under `/api/*`: `next.config.ts` rewrites that prefix to envoy, and
 * rewrites in the array form are evaluated before dynamic routes. A handler
 * there could be shadowed by that rewrite. A distinct prefix sidesteps the
 * question entirely.
 *
 * `force-dynamic` so the env is read per request rather than baked at build —
 * the same footgun `next.config.ts` documents for the envoy upstream.
 */

import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function upstream(): string | null {
  const base = process.env.EXT_PROXY_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

async function relay(req: NextRequest, path: string[]): Promise<Response> {
  const base = upstream();
  if (!base) {
    return NextResponse.json(
      { error: "EXT_PROXY_URL is not configured on the server" },
      { status: 503 },
    );
  }

  const search = req.nextUrl.search ?? "";
  const target = `${base}/${path.join("/")}${search}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  const key = process.env.DIRECT_API_KEY;
  if (key) headers["X-API-Key"] = key;

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = await req.text();
  }

  try {
    const res = await fetch(target, init);
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Never surface the upstream URL or the key in an error the browser sees.
    console.error("[fce-proxy] upstream request failed:", error);
    return NextResponse.json(
      { error: "ext-proxy request failed" },
      { status: 502 },
    );
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  return relay(req, (await ctx.params).path);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  return relay(req, (await ctx.params).path);
}
