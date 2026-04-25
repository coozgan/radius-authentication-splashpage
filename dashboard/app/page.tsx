import { fetchClients } from '@/lib/api';
import ClientsTable from '@/components/ClientsTable';

// Always fetch fresh data — clients can change at any time
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const clients = await fetchClients();

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-xl mx-auto">
          <h1 className="text-xl font-semibold text-gray-900">WiFi Client Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Meraki splash page authorization manager</p>
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto px-6 py-6">
        <ClientsTable initialClients={clients} />
      </div>
    </main>
  );
}
