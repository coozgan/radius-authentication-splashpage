import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WiFi Client Dashboard',
  description: 'Monitor and manage Meraki splash page authorizations',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
