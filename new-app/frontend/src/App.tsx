import React, { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Header } from '@/components/Header';
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
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    }

    loadConfig();
  }, [setConfig]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/download/:id" element={<DownloadPage />} />
        </Routes>
      </main>

      <footer className="border-t py-6 text-center text-sm text-muted-foreground">
        <div className="container">
          <p>
            End-to-end encrypted file sharing.
            Files are encrypted in your browser before upload.
          </p>
        </div>
      </footer>

      <Toaster />
    </div>
  );
}

export default App;
