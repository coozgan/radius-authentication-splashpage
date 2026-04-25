export const runtime = 'edge';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.DASHBOARD_API_URL!;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const res = await fetch(`${API_URL}/clients/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
