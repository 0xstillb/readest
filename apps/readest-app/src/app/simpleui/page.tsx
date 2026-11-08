'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import SimpleUIHome from '@/components/simpleui/SimpleUIHome';
import useSimpleUIMode from '@/components/simpleui/useSimpleUIMode';

export default function SimpleUIHomePage() {
  const router = useRouter();
  const { enabled, ready } = useSimpleUIMode();

  useEffect(() => {
    if (ready && !enabled) router.replace('/library');
  }, [enabled, ready, router]);

  if (!ready || !enabled) return null;

  return <SimpleUIHome />;
}
