import { z } from 'zod';

/** Connection metadata only. Credentials must never be persisted or returned. */
export const RepositoryConnection = z.object({
  id: z.string().regex(/^repo_[a-f0-9]{12}$/),
  runId: z.string(),
  url: z.url(),
  fullName: z.string(),
  defaultBranch: z.string(),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  connectedAt: z.string(),
  files: z.array(z.string()),
  fileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** How the clone authenticated: the GitHub App installation, the request token, or anonymously */
  accessVia: z.enum(['github_app', 'token', 'public']).optional(),
  installationId: z.number().int().positive().optional(),
});
export type RepositoryConnection = z.infer<typeof RepositoryConnection>;

export const ConnectRepositoryRequest = z.object({
  url: z.string().trim().min(1).max(500),
  token: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^[a-zA-Z0-9_]+$/)
    .optional(),
  consent: z.literal(true),
});
export type ConnectRepositoryRequest = z.infer<typeof ConnectRepositoryRequest>;

export const RepositoryResponse = z.object({ repository: RepositoryConnection.nullable() });
export type RepositoryResponse = z.infer<typeof RepositoryResponse>;
