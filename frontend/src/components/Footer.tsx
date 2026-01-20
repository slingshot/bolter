import React from 'react';

export function Footer() {
  return (
    <footer className="w-full pb-6">
      <div className="max-w-container mx-auto px-6 flex flex-col gap-6 items-center">
        {/* Powered by Section */}
        <a target="_blank" href="https://slingshot.fm/?utm_source=bolter&utm_medium=internal&utm_campaign=powered-by" className="flex flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-1">
            <p className="text-paragraph-xxs text-content-tertiary">Powered by</p>
            <div className="h-4 w-[84.628px]">
              {/* Slingshot logo SVG */}
              <img src="/logo-white.svg" alt="Slingshot Logo" className="h-full" />
            </div>
          </div>
          <p className="text-paragraph-xxs text-content-secondary text-center">
            Modern business management for artists & creatives
          </p>
        </a>

        {/* Divider */}
        <div className="w-full h-[0.5px] bg-content-primary opacity-20" />

        {/* Footer Links */}
        <div className="w-full flex items-center justify-between text-paragraph-xxs text-content-secondary font-medium">
          <div className="flex items-center gap-5">
            <a target="_blank" href="https://legal.slingshot.fm/send-terms-2507b" className="hover:text-content-primary transition-colors" rel="noreferrer noopener">
              Terms
            </a>
            <a target="_blank" href="https://legal.slingshot.fm/send-privacy-2507a" className="hover:text-content-primary transition-colors" rel="noreferrer noopener">
              Privacy
            </a>
          </div>
          <div className="flex items-center gap-5">
            <a href="mailto:help@slingshot.fm" className="hover:text-content-primary transition-colors">
              Help
            </a>
            <a href="mailto:legal+dmca@slingshot.fm" className="hover:text-content-primary transition-colors">
              DMCA
            </a>
            <a target="_blank" href="https://github.com/slingshot/bolter" className="hover:text-content-primary transition-colors" rel="noreferrer noopener">
              Source
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
