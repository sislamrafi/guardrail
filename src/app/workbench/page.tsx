import type { Metadata } from 'next';
import { Workbench } from '@/components/workbench/workbench';
import '@/components/workbench/workbench.css';

export const metadata: Metadata = { title: 'GuardRail' };

export default function WorkbenchPage() {
  return <Workbench />;
}
