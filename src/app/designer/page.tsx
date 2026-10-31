import type { Metadata } from 'next';
import { DesignBoard } from '@/components/designer/design-board';
import '@/components/designer/designer.css';

export const metadata: Metadata = { title: 'Design board · GuardRail AI' };

export default async function DesignerPage({ searchParams }: { searchParams: Promise<{ board?: string }> }) {
  const { board } = await searchParams;
  const safe = board && /^[\w-]{1,40}$/.test(board) ? board : 'reference';
  return <DesignBoard board={safe} />;
}
