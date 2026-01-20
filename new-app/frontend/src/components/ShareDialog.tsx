import React, { useState } from 'react';
import { ShieldCheck, Link as LinkIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { cn, copyToClipboard } from '@/lib/utils';
import { useAppStore, type UploadedFile } from '@/stores/app';

interface ShareDialogProps {
  file: UploadedFile;
  onClose: () => void;
}

export function ShareDialog({ file, onClose }: ShareDialogProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = `${file.url}#${file.secretKey}`;

  const handleCopy = async () => {
    const success = await copyToClipboard(shareUrl);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-backdrop-fade-in"
      onClick={onClose}
    >
      <div
        className={cn("card-glass w-full max-w-[600px] p-card shadow-card animate-slide-up")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-5">
          {/* Success Icon */}
          <div className="flex h-[38px] w-[38px] items-center justify-center rounded-element bg-overlay-medium">
            <ShieldCheck className="h-[22px] w-[22px] text-content-secondary" />
          </div>

          {/* Title and Description */}
          <div className="flex flex-col items-center gap-2 text-center">
            <h2 className="text-heading-xs text-content-primary">
              Your file is encrypted and ready to send
            </h2>
            <p className="text-paragraph-xs text-content-secondary">
              Copy the link to share your file <span className="font-medium">{file.name}</span>
            </p>
          </div>

          {/* QR Code and Link */}
          <div className="w-full bg-overlay-subtle border border-border-medium rounded-element p-4 flex flex-col gap-4">
            {/* QR Code */}
            <div className="bg-overlay-medium rounded-element p-6 flex justify-center">
              <QRCodeSVG
                value={shareUrl}
                size={200}
                bgColor="transparent"
                fgColor="#f8f8f8"
                level="H"
              />
            </div>

            {/* Share URL Input */}
            <div className="flex gap-4 items-center">
              <input
                type="text"
                value={shareUrl}
                readOnly
                className="flex-1 rounded-input border border-border-subtle bg-fill-input px-[14px] py-[6.5px] text-paragraph-sm text-content-primary"
              />
              {/*<img*/}
              {/*  src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='46' height='45' viewBox='0 0 46 45'%3E%3Crect width='46' height='45' rx='4' fill='%23f8f8f8'/%3E%3C/svg%3E"*/}
              {/*  alt="QR"*/}
              {/*  className="h-[45px] w-[46px] rounded-input"*/}
              {/*/>*/}
            </div>

            {/* Copy Link Button */}
            <Button onClick={handleCopy} className="w-full">
              <LinkIcon className="mr-2 h-[18px] w-[18px]" />
              {copied ? 'Copied!' : 'Copy link'}
            </Button>

            {/* Close Button */}
            <Button variant="ghost" onClick={onClose} className="w-full">
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
