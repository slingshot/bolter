import { Link } from 'react-router-dom';
import { useAppStore } from '@/stores/app';
import { UI_DEFAULTS } from '@bolter/shared';

export function Header() {
  const { config } = useAppStore();
  const title = config?.customTitle || UI_DEFAULTS.TITLE;

  return (
    <header className="fixed top-0 left-0 right-0 z-50 backdrop-blur-header bg-[rgba(0,0,0,0.75)] border-b border-border-subtle">
      <div className="max-w-container mx-auto px-6 h-16 flex items-center">
        <Link to="/" className="flex items-center gap-2">
            <img src="/logo-white.svg" alt={title} className="h-5" />
        </Link>
      </div>
    </header>
  );
}
