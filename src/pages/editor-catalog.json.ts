import { getCollection } from 'astro:content';

export const prerender = true;

/**
 * Build-time snapshot of published editor fields.
 *
 * The Worker serves this through the Access-protected
 * `GET /api/admin/editor/catalog` endpoint; the file itself also carries a
 * noindex header and is excluded from robots.txt and the sitemap. It contains
 * only data that is already rendered on the public site.
 */
export async function GET() {
  const entries = await getCollection('skills');
  const catalog = {
    entries: entries.map((entry) => {
      const {
        name,
        description,
        type,
        category,
        tags,
        supportedTools,
        prompt,
        installCommand,
        cover,
        gallery,
        featured,
        status,
        sourceRepo,
        sourcePath,
        sourceSha,
        importedSnapshotHash,
        license,
        licenseStatus,
        sourceAttribution,
        createdAt,
        updatedAt,
      } = entry.data;
      return {
        slug: entry.id,
        identity: {
          sourceRepo,
          sourcePath,
          sourceSha,
          importedSnapshotHash,
          license,
          licenseStatus,
          sourceAttribution,
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
        fields: {
          name,
          description,
          type,
          category,
          tags,
          supportedTools,
          prompt,
          installCommand,
          cover,
          gallery,
          featured,
          status,
        },
      };
    }),
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
