import { useEffect } from 'react';
import { useAppStore } from '@/stores/app';

interface DocumentMetaOptions {
  title?: string;
  description?: string;
}

function setMetaContent(selector: string, content: string) {
  const meta = document.querySelector(selector);
  if (meta) {
    meta.setAttribute('content', content);
  }
}

/**
 * Hook to set document title, meta description, and Open Graph tags.
 * Restores default values on unmount.
 */
export function useDocumentMeta({ title, description }: DocumentMetaOptions) {
  const config = useAppStore((state) => state.config);

  useEffect(() => {
    const defaultTitle = config?.customTitle || 'Slingshot';
    const defaultDescription = config?.customDescription || 'Secure, encrypted file sharing';

    // Set custom title
    if (title) {
      const fullTitle = `${title} - ${defaultTitle}`;
      document.title = fullTitle;
      setMetaContent('meta[property="og:title"]', fullTitle);
      setMetaContent('meta[name="twitter:title"]', fullTitle);
    }

    // Set custom description
    if (description) {
      setMetaContent('meta[name="description"]', description);
      setMetaContent('meta[property="og:description"]', description);
      setMetaContent('meta[name="twitter:description"]', description);
    }

    // Restore defaults on unmount
    return () => {
      const fullDefaultTitle = `${defaultTitle} - Secure File Sharing`;
      document.title = fullDefaultTitle;
      setMetaContent('meta[property="og:title"]', fullDefaultTitle);
      setMetaContent('meta[name="twitter:title"]', fullDefaultTitle);
      setMetaContent('meta[name="description"]', defaultDescription);
      setMetaContent('meta[property="og:description"]', defaultDescription);
      setMetaContent('meta[name="twitter:description"]', defaultDescription);
    };
  }, [title, description, config?.customTitle, config?.customDescription]);
}
