export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <p className="text-sm tracking-wide text-neutral-500">The Continental Exchange</p>
      <h1 className="text-4xl font-semibold tracking-tight">Campaign connector</h1>
      <p className="text-lg leading-relaxed text-neutral-700 dark:text-neutral-300">
        Sales reps build paused EmailBison campaigns from Claude. The workspace API key stays on
        this server. A campaign goes live only after the deliverability owner approves it.
      </p>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <dt className="text-sm text-neutral-500">Claude connector URL</dt>
          <dd className="mt-1 font-mono text-sm">/api/mcp</dd>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <dt className="text-sm text-neutral-500">Sign-in</dt>
          <dd className="mt-1 text-sm">TCE Microsoft account, or a personal bearer token from your admin</dd>
        </div>
      </dl>
      <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        This page does not accept an EmailBison key. Health is at <span className="font-mono">/api/health</span>.
        Pending activations are listed for the deliverability owner at{" "}
        <span className="font-mono">/api/admin/activations?status=pending</span>.
      </p>
    </main>
  );
}
