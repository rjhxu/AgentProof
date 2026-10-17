import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript; let Next compile them.
  transpilePackages: ['@agentproof/shared'],
  // Repo-level CLAUDE.md covers AI guidance; don't generate apps/web/AGENTS.md.
  agentRules: false,
};

export default nextConfig;
