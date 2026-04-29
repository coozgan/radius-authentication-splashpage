import { getClients } from './actions';
import ClientsTable from '@/components/ClientsTable';
import type { Client } from '@/lib/types';

// Always re-fetch on each request — the upstream is a small, internal API and
// freshness matters more than caching here. Tag-based revalidation is wired up
// in `app/actions.ts` for future use.
export const revalidate = 0;

export default async function DashboardPage() {
  let clients: Client[] = [];
  let fetchError: string | null = null;

  try {
    clients = await getClients();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : 'Failed to load clients.';
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-xl mx-auto">
          <h1 className="text-xl font-semibold text-gray-900">WiFi Client Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Meraki splash page authorization manager
          </p>
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto px-6 py-6">
        {fetchError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700">
            <strong className="font-medium">Could not load clients:</strong> {fetchError}
          </div>
        ) : (
          <ClientsTable initialClients={clients} />
        )}
      </div>
    </main>
  );
}
