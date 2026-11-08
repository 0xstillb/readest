'use client';

import Menu from '@/components/Menu';
import MenuItem from '@/components/MenuItem';
import { useTranslation } from '@/hooks/useTranslation';
import useSimpleUIBookTitles, { type SimpleUITitleMode } from './useSimpleUIBookTitles';

interface SimpleUITitleModeMenuProps {
  setIsDropdownOpen?: (isOpen: boolean) => void;
  menuClassName?: string;
}

const MODES: { value: SimpleUITitleMode; label: string }[] = [
  { value: 'hidden', label: 'Hide all titles' },
  { value: 'cover', label: 'Titles on cover' },
  { value: 'below', label: 'Titles below cover' },
];

export default function SimpleUITitleModeMenu({
  setIsDropdownOpen,
  menuClassName,
}: SimpleUITitleModeMenuProps) {
  const _ = useTranslation();
  const { titleMode, setTitleMode } = useSimpleUIBookTitles();

  return (
    <Menu
      className={`simpleui-title-mode-menu dropdown-content no-triangle z-20 mt-2 shadow-2xl ${menuClassName || ''}`}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      {MODES.map((mode) => (
        <MenuItem
          key={mode.value}
          label={_(mode.label)}
          toggled={titleMode === mode.value}
          setIsDropdownOpen={setIsDropdownOpen}
          transient
          onClick={() => setTitleMode(mode.value)}
        />
      ))}
    </Menu>
  );
}
