import { NextResponse } from 'next/server';

const API_URL = process.env.DASHBOARD_API_URL!;

export async function DELETE(
  _req: Request,
  { params }: { params: { clientId: string } }
) {
  const clientId = decodeURIComponent(params.clientId);
  const res = await fetch(
    `${API_URL}/clients/${encodeURIComponent(clientId)}`,
    { method: 'DELETE' }
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
