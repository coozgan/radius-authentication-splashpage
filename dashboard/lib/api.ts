/**
 * Thin client for the Dashboard Lambda API (API Gateway).
 * All actual work (DynamoDB, Meraki API, Secrets Manager) happens in the Lambda.
 * This file only contains fetch calls — no AWS credentials needed here.
 */

const API_URL = process.env.DASHBOARD_API_URL;

if (!API_URL) {
  throw new Error('DASHBOARD_API_URL is not set. Copy .env.local.example to .env.local and fill it in.');
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
  const res = await fetch(`${API_URL}/clients`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch clients (${res.status}): ${body}`);
  }
  return res.json();
}
