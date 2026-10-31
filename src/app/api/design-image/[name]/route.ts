import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

// Serves reference screenshots for the /workbench design board. Behind the admin login (middleware).
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const name = (await ctx.params).name.replace(/[^a-z0-9-]/gi, '');
  try {
    const buf = fs.readFileSync(path.join(process.cwd(), 'design', 'reference', `${name}.png`));
    return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
