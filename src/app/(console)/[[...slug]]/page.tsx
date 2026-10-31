import { notFound } from 'next/navigation';
import { VIEWS } from '@/components/console/types';

// The console layout draws everything; this only rejects paths that aren't a console view.
export default async function ConsolePage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  if (slug.length > 2 || (slug[0] && !(VIEWS as readonly string[]).includes(slug[0]))) notFound();
  return null;
}
