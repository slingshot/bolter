import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Toaster } from '@/components/Toaster';
import { HomePage } from '@/pages/Home';
import { DownloadPage } from '@/pages/Download';
import { useAppStore } from '@/stores/app';
import { getConfig } from '@/lib/api';

function App() {
  const { setConfig, config } = useAppStore();

  // Load configuration on mount
  useEffect(() => {
    async function loadConfig() {
      try {
        const data = await getConfig();
        setConfig({
          maxFileSize: data.LIMITS.MAX_FILE_SIZE,
          maxFilesPerArchive: data.LIMITS.MAX_FILES_PER_ARCHIVE,
          maxExpireSeconds: data.LIMITS.MAX_EXPIRE_SECONDS,
          maxDownloads: data.LIMITS.MAX_DOWNLOADS,
          defaultExpireSeconds: data.DEFAULTS.EXPIRE_SECONDS,
          defaultDownloads: data.DEFAULTS.DOWNLOADS,
          expireTimes: data.UI.EXPIRE_TIMES,
          downloadCounts: data.UI.DOWNLOAD_COUNTS,
          customTitle: data.UI.TITLE,
          customDescription: data.UI.DESCRIPTION,
        });

        // Update page metadata with config values
        if (data.UI.TITLE) {
          document.title = `${data.UI.TITLE} - Secure File Sharing`;
        }
        if (data.UI.DESCRIPTION) {
          const metaDescription = document.querySelector('meta[name="description"]');
          if (metaDescription) {
            metaDescription.setAttribute('content', data.UI.DESCRIPTION);
          }
        }
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    }

    loadConfig();
  }, [setConfig]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/download/:id" element={<DownloadPage />} />
        </Routes>
      </main>
      <Footer />
      <Toaster />
    </div>
  );
}

export default App;
