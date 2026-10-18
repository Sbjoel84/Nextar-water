// TEMPORARY: used only while no Supabase project is configured (see client.ts
// and src/lib/auth-bypass.ts). Instead of letting every request hit a dead
// address — which left pages blank or spinning — reads come back empty so the
// UI renders with zeros/empty tables, and writes fail with a clear message.
// Delete this file once the new Supabase project is connected.

// Placeholder for the single Water factory, so factory-scoped pages render.
export const OFFLINE_FACTORY_ID = "00000000-0000-4000-8000-000000000001";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Content-Range": "*/0", ...headers },
  });

export const offlineFetch: typeof fetch = async (input, init) => {
  const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const accept = new Headers(init?.headers ?? request?.headers).get("Accept") ?? "";

  if (!url.pathname.startsWith("/rest/v1/")) {
    // Auth, storage, functions: nothing to talk to.
    return json({ message: "No database connected yet", error: "offline" }, 503);
  }

  const isRpc = url.pathname.startsWith("/rest/v1/rpc/");
  const isRead = method === "GET" || method === "HEAD" || (isRpc && method === "POST");
  if (!isRead) {
    return json(
      { code: "OFFLINE", message: "No database connected yet — changes can't be saved.", details: "", hint: "" },
      503,
    );
  }
  if (method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Range": "*/0" } });

  if (url.pathname === "/rest/v1/factories") {
    return json([
      {
        id: OFFLINE_FACTORY_ID,
        code: "water",
        name: "Water Factory",
        created_at: new Date(0).toISOString(),
      },
    ]);
  }

  if (accept.includes("application/vnd.pgrst.object+json")) {
    // .single(): PostgREST's "no rows" error.
    return json(
      { code: "PGRST116", message: "No database connected yet", details: "0 rows", hint: null },
      406,
    );
  }

  return json([]);
};
