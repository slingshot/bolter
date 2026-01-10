import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Download,
  Lock,
  Clock,
  FileIcon,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Keychain } from '@/lib/crypto';
import { getMetadata, downloadFile, fileExists } from '@/lib/api';
import { formatBytes, formatTimeLimit, triggerDownload } from '@/lib/utils';

type DownloadState = 'loading' | 'ready' | 'downloading' | 'complete' | 'error' | 'not-found';

interface FileMetadata {
  name: string;
  size: number;
  type: string;
  ttl: number;
  encrypted: boolean;
  files?: { name: string; size: number; type: string }[];
}

export function DownloadPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [state, setState] = useState<DownloadState>('loading');
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [keychain, setKeychain] = useState<Keychain | null>(null);

  // Extract secret key from URL hash
  useEffect(() => {
    if (!id) {
      setState('not-found');
      return;
    }

    const secretKey = location.hash.slice(1); // Remove the # prefix

    async function loadMetadata() {
      try {
        // Check if file exists
        const exists = await fileExists(id);
        if (!exists) {
          setState('not-found');
          return;
        }

        // Create keychain if we have a secret key
        const kc = secretKey ? new Keychain(secretKey) : null;
        setKeychain(kc);

        // Fetch metadata
        const meta = await getMetadata(id, kc || undefined);
        setMetadata(meta as FileMetadata);
        setState('ready');
      } catch (e: any) {
        console.error('Failed to load metadata:', e);
        if (e.message.includes('404') || e.message.includes('401')) {
          setState('not-found');
        } else {
          setError(e.message);
          setState('error');
        }
      }
    }

    loadMetadata();
  }, [id, location.hash]);

  const handleDownload = async () => {
    if (!id) return;

    setState('downloading');
    setProgress(0);

    try {
      const result = await downloadFile(
        id,
        keychain,
        (loaded, total) => {
          setProgress((loaded / total) * 100);
        }
      );

      // Trigger browser download
      triggerDownload(result.blob, result.filename);
      setState('complete');
    } catch (e: any) {
      console.error('Download failed:', e);
      setError(e.message);
      setState('error');
    }
  };

  if (state === 'loading') {
    return (
      <div className="container flex min-h-[60vh] items-center justify-center py-8">
        <div className="text-center">
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
          <p className="mt-4 text-muted-foreground">Loading file information...</p>
        </div>
      </div>
    );
  }

  if (state === 'not-found') {
    return (
      <div className="container py-8">
        <div className="mx-auto max-w-md">
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <AlertCircle className="h-8 w-8 text-muted-foreground" />
              </div>
              <CardTitle>File not found</CardTitle>
              <CardDescription>
                This file may have expired or been deleted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="w-full" onClick={() => navigate('/')}>
                Upload a new file
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="container py-8">
        <div className="mx-auto max-w-md">
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                <AlertCircle className="h-8 w-8 text-destructive" />
              </div>
              <CardTitle>Download failed</CardTitle>
              <CardDescription>{error || 'An error occurred'}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full" onClick={() => setState('ready')}>
                Try again
              </Button>
              <Button variant="outline" className="w-full" onClick={() => navigate('/')}>
                Upload a new file
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (state === 'complete') {
    return (
      <div className="container py-8">
        <div className="mx-auto max-w-md">
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20">
                <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <CardTitle>Download complete!</CardTitle>
              <CardDescription>
                Your file has been downloaded and decrypted successfully.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full" onClick={handleDownload}>
                Download again
              </Button>
              <Button variant="outline" className="w-full" onClick={() => navigate('/')}>
                Upload a new file
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <FileIcon className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="break-all">{metadata?.name}</CardTitle>
            <CardDescription>
              Someone shared a file with you
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* File info */}
            <div className="rounded-lg bg-muted p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Size</span>
                <span className="font-medium">{formatBytes(metadata?.size || 0)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Expires in</span>
                <span className="font-medium flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {formatTimeLimit(metadata?.ttl || 0)}
                </span>
              </div>
              {metadata?.encrypted && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Security</span>
                  <span className="font-medium flex items-center gap-1 text-green-600 dark:text-green-400">
                    <Lock className="h-4 w-4" />
                    End-to-end encrypted
                  </span>
                </div>
              )}
            </div>

            {/* Download button or progress */}
            {state === 'downloading' ? (
              <div className="space-y-3">
                <Progress value={progress} className="h-2" />
                <p className="text-center text-sm text-muted-foreground">
                  Downloading and decrypting... {Math.round(progress)}%
                </p>
              </div>
            ) : (
              <Button className="w-full" size="lg" onClick={handleDownload}>
                <Download className="mr-2 h-5 w-5" />
                Download file
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
