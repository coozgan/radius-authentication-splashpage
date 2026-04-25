'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { Client } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = 'active' | 'expiring' | 'expired';
type SortField = 'ClientName' | 'ExpirationTimestamp' | 'ConnectionTimestamp' | 'SSID';

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function getStatus(expiration?: string): Status {
  if (!expiration) return 'expired';
  const ms = new Date(expiration).getTime() - Date.now();
  if (ms < 0) return 'expired';
  if (ms < 14 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}

function formatDate(ts?: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-SG', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Asia/Singapore',
    });
  } catch { return ts; }
}

function daysUntil(ts?: string): string {
  if (!ts) return '';
  const days = Math.ceil((new Date(ts).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return 'today';
  return `in ${days}d`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Status }) {
  const map = {
    active:   { bg: 'bg-green-100 text-green-800',  label: 'Active' },
    expiring: { bg: 'bg-yellow-100 text-yellow-800', label: 'Expiring Soon' },
    expired:  { bg: 'bg-red-100 text-red-800',       label: 'Expired' },
  };
  const { bg, label } = map[status];
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${bg}`}>{label}</span>;
}

function Spinner() {
  return (
    <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function SortButton({ field, current, dir, onClick, children }: {
  field: SortField; current: SortField; dir: 'asc' | 'desc';
  onClick: (f: SortField) => void; children: React.ReactNode;
}) {
  const active = field === current;
  return (
    <button onClick={() => onClick(field)} className="flex items-center gap-1 hover:text-gray-700 focus:outline-none">
      {children}
      <span className={active ? 'text-gray-600' : 'text-gray-300'}>
        {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  );
}

function Toast({ type, message }: { type: 'success' | 'error'; message: string }) {
  return (
    <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-white text-sm max-w-sm ${type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
      <span>{type === 'success' ? '✓' : '✕'}</span>
      <span>{message}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ClientsTable({ initialClients }: { initialClients: Client[] }) {
  const [clients,           setClients]          = useState<Client[]>(initialClients);
  const [selected,          setSelected]         = useState<Set<string>>(new Set());
  const [ssidFilter,        setSsidFilter]       = useState('all');
  const [statusFilter,      setStatusFilter]     = useState<'all' | Status>('all');
  const [search,            setSearch]           = useState('');
  const [sortField,         setSortField]        = useState<SortField>('ExpirationTimestamp');
  const [sortDir,           setSortDir]          = useState<'asc' | 'desc'>('asc');
  const [rowLoading,        setRowLoading]       = useState<Record<string, boolean>>({});
  const [bulkAction,        setBulkAction]       = useState<'extend' | 'delete' | null>(null);
  const [bulkConfirm,       setBulkConfirm]      = useState<'extend' | 'delete' | null>(null);
  const [confirmDeleteId,   setConfirmDeleteId]  = useState<string | null>(null);
  const [toast,             setToast]            = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [refreshing,        setRefreshing]       = useState(false);

  // Auto-cancel row-level delete confirmation after 4 s of inactivity
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (confirmDeleteId) {
      confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 4000);
    }
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); };
  }, [confirmDeleteId]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const ssids = useMemo(() => {
    const set = new Set<string>();
    clients.forEach((c) => { if (c.SSID) set.add(c.SSID); });
    return Array.from(set).sort();
  }, [clients]);

  const stats = useMemo(() => ({
    total:    clients.length,
    active:   clients.filter((c) => getStatus(c.ExpirationTimestamp) === 'active').length,
    expiring: clients.filter((c) => getStatus(c.ExpirationTimestamp) === 'expiring').length,
    expired:  clients.filter((c) => getStatus(c.ExpirationTimestamp) === 'expired').length,
  }), [clients]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const result = clients.filter((c) => {
      if (ssidFilter !== 'all' && c.SSID !== ssidFilter) return false;
      if (statusFilter !== 'all' && getStatus(c.ExpirationTimestamp) !== statusFilter) return false;
      if (q && !(
        c.ClientName?.toLowerCase().includes(q) ||
        c.MacAddress?.toLowerCase().includes(q) ||
        c.ClientID?.toLowerCase().includes(q)
      )) return false;
      return true;
    });
    result.sort((a, b) => {
      const av = (sortField === 'ClientName' ? a.ClientName : sortField === 'SSID' ? a.SSID : a[sortField]) ?? '';
      const bv = (sortField === 'ClientName' ? b.ClientName : sortField === 'SSID' ? b.SSID : b[sortField]) ?? '';
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return result;
  }, [clients, ssidFilter, statusFilter, search, sortField, sortDir]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const toggleRow = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = () => setSelected(
    selected.size === filtered.length && filtered.length > 0
      ? new Set()
      : new Set(filtered.map((c) => c.ClientID))
  );

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/clients');
      if (res.ok) { setClients(await res.json()); setSelected(new Set()); }
    } catch { showToast('error', 'Refresh failed'); }
    finally { setRefreshing(false); }
  };

  const handleExtend = async (clientId: string) => {
    setRowLoading((p) => ({ ...p, [clientId]: true }));
    try {
      const res  = await fetch(`/api/clients/${encodeURIComponent(clientId)}/extend`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setClients((p) => p.map((c) => c.ClientID === clientId
          ? { ...c, ExpirationTimestamp: data.newExpiration, LastRenewed: data.lastRenewed }
          : c));
        showToast('success', `Extended: ${clientId}`);
      } else {
        showToast('error', data.error ?? 'Extension failed');
      }
    } catch { showToast('error', 'Network error'); }
    finally { setRowLoading((p) => ({ ...p, [clientId]: false })); }
  };

  const handleDelete = async (clientId: string) => {
    setConfirmDeleteId(null);
    setRowLoading((p) => ({ ...p, [clientId]: true }));
    try {
      const res  = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setClients((p) => p.filter((c) => c.ClientID !== clientId));
        setSelected((p) => { const next = new Set(p); next.delete(clientId); return next; });
        showToast('success', `Deleted: ${clientId}`);
      } else {
        showToast('error', data.error ?? 'Delete failed');
      }
    } catch { showToast('error', 'Network error'); }
    finally { setRowLoading((p) => ({ ...p, [clientId]: false })); }
  };

  const handleBulkExtend = async () => {
    if (selected.size === 0) return;
    setBulkAction('extend'); setBulkConfirm(null);
    try {
      const res  = await fetch('/api/clients/bulk-extend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (data.succeeded?.length > 0) {
        const map = new Map<string, string>(
          data.succeeded.map((s: { clientId: string; newExpiration: string }) => [s.clientId, s.newExpiration])
        );
        setClients((p) => p.map((c) => { const exp = map.get(c.ClientID); return exp ? { ...c, ExpirationTimestamp: exp } : c; }));
      }
      const ok = data.succeeded?.length ?? 0;
      const fail = data.failed?.length ?? 0;
      showToast(fail > 0 && ok === 0 ? 'error' : 'success', `${ok} extended${fail > 0 ? `, ${fail} failed` : ''}`);
      setSelected(new Set());
    } catch { showToast('error', 'Network error'); }
    finally { setBulkAction(null); }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    setBulkAction('delete'); setBulkConfirm(null);
    try {
      const ids  = Array.from(selected);
      const res  = await fetch('/api/clients/bulk-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: ids }),
      });
      const data = await res.json();
      const deleted: string[] = data.succeeded ?? [];
      if (deleted.length > 0) {
        const deletedSet = new Set(deleted);
        setClients((p) => p.filter((c) => !deletedSet.has(c.ClientID)));
        setSelected(new Set());
      }
      const ok   = deleted.length;
      const fail = data.failed?.length ?? 0;
      showToast(fail > 0 && ok === 0 ? 'error' : 'success', `${ok} deleted${fail > 0 ? `, ${fail} failed` : ''}`);
    } catch { showToast('error', 'Network error'); }
    finally { setBulkAction(null); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-24">
      {toast && <Toast type={toast.type} message={toast.message} />}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total',            value: stats.total,    accent: 'border-gray-200'  },
          { label: 'Active',           value: stats.active,   accent: 'border-green-300' },
          { label: 'Expiring ≤14 days',value: stats.expiring, accent: 'border-yellow-300'},
          { label: 'Expired',          value: stats.expired,  accent: 'border-red-300'   },
        ].map((s) => (
          <div key={s.label} className={`bg-white rounded-lg border ${s.accent} shadow-sm p-4`}>
            <p className="text-xs text-gray-500">{s.label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap items-center gap-3">
        <input
          type="text" placeholder="Search name or MAC…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select value={ssidFilter} onChange={(e) => setSsidFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All SSIDs</option>
          {ssids.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="expiring">Expiring Soon</option>
          <option value="expired">Expired</option>
        </select>
        <span className="text-sm text-gray-400 ml-auto">{filtered.length} of {clients.length} shown</span>
        <button onClick={handleRefresh} disabled={refreshing}
          className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50">
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length}
                    onChange={toggleAll} className="rounded border-gray-300" />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ClientName" current={sortField} dir={sortDir} onClick={handleSort}>Client Name</SortButton>
                </th>
                <th className="px-4 py-3 text-left">MAC Address</th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="SSID" current={sortField} dir={sortDir} onClick={handleSort}>SSID</SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ConnectionTimestamp" current={sortField} dir={sortDir} onClick={handleSort}>Connected</SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ExpirationTimestamp" current={sortField} dir={sortDir} onClick={handleSort}>Expires</SortButton>
                </th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">No clients match the current filters.</td>
                </tr>
              ) : filtered.map((client) => {
                const isLoading  = rowLoading[client.ClientID];
                const isSelected = selected.has(client.ClientID);
                const isPending  = confirmDeleteId === client.ClientID;

                return (
                  <tr key={client.ClientID}
                    className={`transition-colors ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleRow(client.ClientID)}
                        className="rounded border-gray-300" />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                      {client.ClientName || <span className="text-gray-400 italic">Unknown</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-500 whitespace-nowrap">
                      {client.MacAddress || client.ClientID}
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {client.SSID || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {formatDate(client.ConnectionTimestamp)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-gray-700">{formatDate(client.ExpirationTimestamp)}</span>
                      {client.ExpirationTimestamp && (
                        <span className="block text-xs text-gray-400 mt-0.5">{daysUntil(client.ExpirationTimestamp)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={getStatus(client.ExpirationTimestamp)} />
                    </td>

                    {/* ── Actions cell ── */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {/* Extend */}
                        <button onClick={() => handleExtend(client.ClientID)}
                          disabled={isLoading || isPending}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                          {isLoading ? <><Spinner /> Extending…</> : 'Extend'}
                        </button>

                        {/* Delete — two-step inline confirmation */}
                        {isPending ? (
                          <span className="inline-flex items-center gap-1">
                            <button onClick={() => handleDelete(client.ClientID)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors">
                              Confirm?
                            </button>
                            <button onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors">
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(client.ClientID)}
                            disabled={isLoading}
                            className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-gray-900 text-white px-5 py-3 rounded-full shadow-2xl">
          <span className="text-sm font-medium">
            {selected.size} client{selected.size !== 1 ? 's' : ''} selected
          </span>

          {/* Extend all */}
          {bulkConfirm !== 'delete' && (
            <button onClick={handleBulkExtend} disabled={bulkAction !== null}
              className="flex items-center gap-1.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-full transition-colors">
              {bulkAction === 'extend' ? <><Spinner /> Extending…</> : 'Extend All'}
            </button>
          )}

          {/* Delete all — two-step confirmation */}
          {bulkConfirm === 'delete' ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-red-300">Delete {selected.size} record{selected.size !== 1 ? 's' : ''}?</span>
              <button onClick={handleBulkDelete} disabled={bulkAction !== null}
                className="flex items-center gap-1.5 bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-full transition-colors">
                {bulkAction === 'delete' ? <><Spinner /> Deleting…</> : 'Yes, Delete'}
              </button>
              <button onClick={() => setBulkConfirm(null)}
                className="text-gray-400 hover:text-white text-sm">
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setBulkConfirm('delete')} disabled={bulkAction !== null}
              className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-full transition-colors">
              Delete Selected
            </button>
          )}

          {bulkConfirm !== 'delete' && (
            <button onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-white text-sm">
              ✕ Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
