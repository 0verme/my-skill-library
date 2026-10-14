import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';

const externalUrl = z.url().refine(
  (value) => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  },
  { message: 'URL must use HTTP(S) and must not include embedded credentials.' },
);

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isSafeGitHubRepository(value: string) {
  const [owner, repository, ...rest] = value.split('/');
  return (
    rest.length === 0 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner ?? '') &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository ?? '') &&
    repository !== '.' &&
    repository !== '..'
  );
}

function isSafeRepositoryPath(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded.length > 0 &&
      !decoded.startsWith('/') &&
      !decoded.includes('\\') &&
      !hasControlCharacters(decoded) &&
      !/^[a-z][a-z0-9+.-]*:/i.test(decoded) &&
      !decoded.split('/').some((segment) => segment === '.' || segment === '..')
    );
  } catch {
    return false;
  }
}

const mediaSource = z.string().refine(
  (value) => {
    if (value.startsWith('/skills/')) {
      try {
        const decoded = decodeURIComponent(value);
        return (
          decoded.startsWith('/skills/') &&
          !decoded.includes('\\') &&
          !hasControlCharacters(decoded) &&
          !decoded.split('/').some((segment) => segment === '.' || segment === '..')
        );
      } catch {
        return false;
      }
    }

    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  },
  { message: 'Media must be a safe /skills/ path or an HTTPS URL without credentials.' },
);

const galleryItem = z.object({
  type: z.enum(['image', 'video']),
  src: mediaSource,
  alt: z.string().min(1),
  caption: z.string().optional(),
  before: mediaSource.optional(),
  after: mediaSource.optional(),
  attribution: z.string().optional(),
  sourceUrl: externalUrl.optional(),
});

const skills = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/skills' }),
  schema: z
    .object({
      name: z.string().min(1),
      description: z.string().min(1).max(220),
      type: z.enum(['skill', 'prompt', 'workflow']),
      category: z.string().min(1),
      tags: z.array(z.string()).default([]),
      cover: mediaSource.optional(),
      gallery: z.array(galleryItem).default([]),
      supportedTools: z.array(z.string()).default([]),
      prompt: z.string().min(1).optional(),
      sourceUrl: externalUrl.optional(),
      repoUrl: externalUrl.optional(),
      sourceRepo: z
        .string()
        .refine(
          isSafeGitHubRepository,
          'Source repository must use a safe GitHub owner/repo format.',
        )
        .optional(),
      sourcePath: z
        .string()
        .refine(isSafeRepositoryPath, {
          message: 'Source path must be a safe repository-relative path.',
        })
        .optional(),
      sourceSha: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, 'Source SHA must be a full Git commit hash.')
        .optional(),
      skillPath: z
        .string()
        .refine(isSafeRepositoryPath, {
          message: 'Skill path must be a safe repository-relative path.',
        })
        .optional(),
      license: z.string().optional(),
      licenseStatus: z
        .enum(['original', 'redistributable', 'restricted', 'unknown', 'not-applicable'])
        .optional(),
      installCommand: z.string().min(1).optional(),
      featured: z.boolean().default(false),
      status: z.enum(['demo', 'unverified', 'verified']),
      createdAt: z.coerce.date(),
      updatedAt: z.coerce.date(),
    })
    .superRefine((entry, context) => {
      if (entry.type === 'prompt' && !entry.prompt) {
        context.addIssue({
          code: 'custom',
          path: ['prompt'],
          message: 'Prompt entries must include a non-empty prompt field.',
        });
      }
    }),
});

export const collections = { skills };
