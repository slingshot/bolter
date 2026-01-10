import React from 'react';
import { Clock, Download, Lock, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatTimeLimit, formatDownloadLimit } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

export function UploadSettings() {
  const {
    encrypted,
    setEncrypted,
    timeLimit,
    setTimeLimit,
    downloadLimit,
    setDownloadLimit,
    config,
  } = useAppStore();

  const expireTimes = config?.expireTimes || [300, 3600, 86400, 604800];
  const downloadCounts = config?.downloadCounts || [1, 2, 3, 4, 5, 20, 50, 100];

  return (
    <div className="mt-6 space-y-4">
      {/* Encryption Toggle */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="flex items-center gap-3">
          {encrypted ? (
            <Lock className="h-5 w-5 text-primary" />
          ) : (
            <Unlock className="h-5 w-5 text-muted-foreground" />
          )}
          <div>
            <p className="font-medium">End-to-End Encryption</p>
            <p className="text-sm text-muted-foreground">
              {encrypted
                ? 'Files are encrypted before upload'
                : 'Files will be uploaded without encryption'}
            </p>
          </div>
        </div>
        <Button
          variant={encrypted ? 'default' : 'outline'}
          size="sm"
          onClick={() => setEncrypted(!encrypted)}
        >
          {encrypted ? 'On' : 'Off'}
        </Button>
      </div>

      {/* Time and Download Limits */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4" />
            Expires after
          </label>
          <Select
            value={String(timeLimit)}
            onValueChange={(v) => setTimeLimit(parseInt(v, 10))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {expireTimes.map((time) => (
                <SelectItem key={time} value={String(time)}>
                  {formatTimeLimit(time)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Download className="h-4 w-4" />
            Download limit
          </label>
          <Select
            value={String(downloadLimit)}
            onValueChange={(v) => setDownloadLimit(parseInt(v, 10))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {downloadCounts.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {formatDownloadLimit(count)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
