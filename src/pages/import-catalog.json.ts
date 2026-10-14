import { getCollection } from 'astro:content';

export const prerender = true;

export async function GET() {
  const entries = await getCollection('skills');
  const catalog = {
    entries: entries.map((entry) => ({
      slug: entry.id,
      sourceRepo: entry.data.sourceRepo,
      sourcePath: entry.data.sourcePath,
      sourceSha: entry.data.sourceSha,
      importedSnapshotHash: entry.data.importedSnapshotHash,
    })),
  };
  return new Response(JSON.stringify(catalog), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
