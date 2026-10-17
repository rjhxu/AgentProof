import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentProof',
  description: 'The testing ground for AI-powered commerce.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="flex items-center justify-between border-b border-[var(--line)] px-6 py-3">
          <span className="font-semibold tracking-tight">AgentProof</span>
          <span className="text-sm text-[var(--muted)]">
            Test the agents. Fix the failures. Prove the purchase path works.
          </span>
        </header>
        {children}
      </body>
    </html>
  );
}
