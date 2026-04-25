/**
 * Thin client for the Dashboard Lambda API (API Gateway).
 * All actual work (DynamoDB, Meraki API, Secrets Manager) happens in the Lambda.
 * This file only contains fetch calls — no AWS credentials needed here.
 */

// Deferred — checked at call time, not at module load, so `next build` never
// crashes when the env var is absent from the CI/CD build environment.
function apiUrl(): string {
  const url = process.env.DASHBOARD_API_URL;
  if (!url) throw new Error('DASHBOARD_API_URL is not set. Add it in Cloudflare Pages → Settings → Environment Variables.');
  return url;
}

export interface Client {
  ClientID: string;
  ClientName?: string;
  MacAddress?: string;
  SSID?: string;
  ClientIP?: string;
  ConnectionTimestamp?: string;
  ExpirationTimestamp?: string;
  LastUpdated?: string;
  LastRenewed?: string;
  ConnectionCount?: number;
  RenewalCount?: number;
  MerakiClientID?: string;
}

export async function fetchClients(): Promise<Client[]> {
  const res = await fetch(`${apiUrl()}/clients`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch clients (${res.status}): ${body}`);
  }
  return res.json();
}
