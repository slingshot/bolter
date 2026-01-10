import React, { useState } from 'react';
import { Copy, Check, Link2, Mail, QrCode, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatBytes, formatTimeLimit, copyToClipboard } from '@/lib/utils';
import { useAppStore, type UploadedFile } from '@/stores/app';
import { deleteFile } from '@/lib/api';

interface ShareDialogProps {
  file: UploadedFile;
  onClose: () => void;
}

export function ShareDialog({ file, onClose }: ShareDialogProps) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { removeUploadedFile, addToast } = useAppStore();

  const shareUrl = `${file.url}#${file.secretKey}`;

  const handleCopy = async () => {
    const success = await copyToClipboard(shareUrl);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteFile(file.id, file.ownerToken);
      removeUploadedFile(file.id);
      addToast({ title: 'File deleted', variant: 'success' });
      onClose();
    } catch (e) {
      addToast({ title: 'Failed to delete file', variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  const timeUntilExpiry = Math.max(0, file.expiresAt.getTime() - Date.now()) / 1000;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Share your file
          </CardTitle>
          <CardDescription>
            Copy the link below to share your encrypted file
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* File info */}
          <div className="rounded-lg bg-muted p-3">
            <p className="font-medium truncate">{file.name}</p>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>{formatBytes(file.size)}</span>
              <span>•</span>
              <span>Expires in {formatTimeLimit(timeUntilExpiry)}</span>
              <span>•</span>
              <span>{file.downloadLimit - file.downloadCount} downloads left</span>
            </div>
          </div>

          {/* Share URL */}
          <div className="flex gap-2">
            <input
              type="text"
              value={shareUrl}
              readOnly
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            />
            <Button onClick={handleCopy} className="shrink-0">
              {copied ? (
                <>
                  <Check className="mr-2 h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </>
              )}
            </Button>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                window.open(
                  `mailto:?subject=File shared with you&body=Download your file: ${encodeURIComponent(shareUrl)}`,
                  '_blank'
                );
              }}
            >
              <Mail className="mr-2 h-4 w-4" />
              Email
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
