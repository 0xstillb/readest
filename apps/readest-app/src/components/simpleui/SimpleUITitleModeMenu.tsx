'use client';

import Menu from '@/components/Menu';
import MenuItem from '@/components/MenuItem';
import { useTranslation } from '@/hooks/useTranslation';
import useSimpleUIBookTitles, { type SimpleUITitleMode } from './useSimpleUIBookTitles';

interface SimpleUITitleModeMenuProps {
  setIsDropdownOpen?: (isOpen: boolean) => void;
  menuClassName?: string;
}

export default function SimpleUITitleModeMenu({
  setIsDropdownOpen,
  menuClassName,
}: SimpleUITitleModeMenuProps) {
  const _ = useTranslation();
  const { titleMode, setTitleMode } = useSimpleUIBookTitles();
  // The labels have to stay literal: the translation scanner only finds
  // `_('…')` calls with a literal argument, and it drops every key it
  // cannot find.
  const modes: { value: SimpleUITitleMode; label: string }[] = [
    { value: 'hidden', label: _('Hide all titles') },
    { value: 'cover', label: _('Titles on cover') },
    { value: 'below', label: _('Titles below cover') },
  ];

  return (
    <Menu
      className={`simpleui-title-mode-menu dropdown-content no-triangle z-20 mt-2 shadow-2xl ${menuClassName || ''}`}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      {modes.map((mode) => (
        <MenuItem
          key={mode.value}
          label={mode.label}
          toggled={titleMode === mode.value}
          setIsDropdownOpen={setIsDropdownOpen}
          transient
          onClick={() => setTitleMode(mode.value)}
        />
      ))}
    </Menu>
  );
}
