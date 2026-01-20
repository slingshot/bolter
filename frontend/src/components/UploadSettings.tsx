import React, { useState } from 'react';
import { Toggle } from '@/components/ui/toggle';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatTimeLimit, formatDownloadLimit } from '@/lib/utils';
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

  const [requirePassword, setRequirePassword] = useState(false);
  const [password, setPassword] = useState('');

  const expireTimes = config?.expireTimes || [300, 3600, 86400, 604800];
  const downloadCounts = config?.downloadCounts || [1, 2, 3, 4, 5, 20, 50, 100];

  return (
    <div className="flex flex-col gap-3">
      {/* Encryption Toggle */}
      <div className="flex flex-col gap-3">
        <Toggle
          checked={encrypted}
          onCheckedChange={setEncrypted}
          label="Encrypt files for enhanced security"
        />
      </div>

      {/* Divider */}
      <div className="h-[0.5px] bg-border-medium" />

      {/* Time and Download Limits */}
      <div className="flex items-center gap-2">
        <Toggle
          checked={true}
          onCheckedChange={() => {}}
          label="Expires after"
        />
        <div className="flex flex-1 items-center gap-2">
          <Select
            value={String(downloadLimit)}
            onValueChange={(v) => setDownloadLimit(parseInt(v, 10))}
          >
            <SelectTrigger className="flex-1">
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
          <span className="text-paragraph-xs text-content-primary font-medium">or</span>
          <Select
            value={String(timeLimit)}
            onValueChange={(v) => setTimeLimit(parseInt(v, 10))}
          >
            <SelectTrigger className="flex-1">
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
      </div>

      {/* Divider */}
      <div className="h-[0.5px] bg-border-medium" />

      {/* Password Protection */}
      <div className="flex items-center gap-2">
        <Toggle
          checked={requirePassword}
          onCheckedChange={setRequirePassword}
          label="Require password"
        />
        {requirePassword && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="flex-1 rounded-input border border-border-subtle bg-fill-input px-[14px] py-[6.5px] text-paragraph-sm text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-2 focus:ring-content-primary focus:ring-offset-2 focus:ring-offset-background-page"
          />
        )}
      </div>
    </div>
  );
}
