import { getDb } from "@/lib/db";
import { googleConfigured, microsoftConfigured, readEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ txn?: string }>;
}) {
  const { txn = "" } = await searchParams;
  const env = readEnv();
  const microsoft = microsoftConfigured(env);
  const google = googleConfigured(env);
  const db = await getDb();
  const rows = await db.query<{ redirect_uri: string; client_id: string }>(
    `SELECT redirect_uri, client_id FROM oauth_transactions WHERE id = $1`,
    [txn],
  );
  const txnRow = rows[0];
  let host = "unknown";
  let loopback = false;
  if (txnRow) {
    try {
      const target = new URL(txnRow.redirect_uri);
      host = target.host;
      loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1";
    } catch {
      host = "invalid";
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-16">
      <p className="text-sm text-neutral-500">The Continental Exchange</p>
      <h1 className="text-3xl font-semibold tracking-tight">Connect Claude</h1>
      {!txnRow ? (
        <p>This sign-in session expired. Start again from Claude.</p>
      ) : (
        <>
          <p className="leading-relaxed">
            Claude is asking to build paused campaigns as you. After you sign in with your TCE
            Microsoft account, you will be sent back to:
          </p>
          <p className="rounded-lg border border-neutral-200 px-4 py-3 font-mono text-lg dark:border-neutral-800">
            {host}
          </p>
          {loopback ? (
            <p className="text-sm text-amber-800 dark:text-amber-200">
              That address is on this computer. Any local program can listen there. Continue only if
              you just started this connection from Claude Code.
            </p>
          ) : null}
          {microsoft || google ? (
            <div className="flex flex-col items-start gap-3">
              {microsoft ? (
                <form action="/api/oauth/microsoft/start" method="post">
                  <input type="hidden" name="txn" value={txn} />
                  <button
                    className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                    type="submit"
                  >
                    Continue with Microsoft
                  </button>
                </form>
              ) : null}
              {google ? (
                <form action="/api/oauth/google/start" method="post">
                  <input type="hidden" name="txn" value={txn} />
                  <button
                    className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
                    type="submit"
                  >
                    Continue with Google
                  </button>
                </form>
              ) : null}
            </div>
          ) : (
            <p className="text-sm leading-relaxed">
              Microsoft sign-in is not configured on this server yet. Ask your admin for a personal
              bearer token and add it in Claude Code or Claude Desktop.
            </p>
          )}
        </>
      )}
    </main>
  );
}
