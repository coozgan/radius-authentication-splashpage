export const runtime = 'edge';
import { NextResponse } from 'next/server';

const API_URL = process.env.DASHBOARD_API_URL!;

export async function GET() {
  const res = await fetch(`${API_URL}/clients`, { cache: 'no-store' });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
