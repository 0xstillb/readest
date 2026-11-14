import React, { useEffect, useRef } from 'react';

// Preload the image while the reader is visible. On some e-ink firmwares the
// last composed frame becomes the sleep screen; timing is device dependent.
const SleepCover: React.FC<{ src?: string | null }> = ({ src }) => {
  const coverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      if (coverRef.current) {
        coverRef.current.style.visibility = document.hidden ? 'visible' : 'hidden';
      }
    };
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  if (!src) return null;
  return (
    <div
      ref={coverRef}
      aria-hidden='true'
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        visibility: 'hidden',
        pointerEvents: 'none',
        background: 'white',
      }}
    >
      <img src={src} alt='' style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    </div>
  );
};

export default SleepCover;
